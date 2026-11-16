// check.mjs: node --check sweep and manifest reference validation, on temp fixture projects.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkProject, manifestReferences } from '../check.mjs';

const CHECK_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check.mjs');
const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const VALID_MANIFEST = {
  manifest_version: 3,
  name: 'fixture',
  version: '1.0.0',
  background: { service_worker: 'src/background.js', type: 'module' },
  side_panel: { default_path: 'sidepanel.html' },
  options_page: 'options.html',
  action: { default_icon: { 16: 'icons/icon16.png' } },
  icons: { 16: 'icons/icon16.png', 128: 'icons/icon128.png' },
};

function makeFixture({ files = {}, manifest = VALID_MANIFEST } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agyb-check-'));
  tempDirs.push(root);
  const all = {
    'extension/manifest.json': typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    'extension/src/background.js': 'export {};',
    'extension/sidepanel.html': '<!doctype html>',
    'extension/options.html': '<!doctype html>',
    'extension/icons/icon16.png': 'png',
    'extension/icons/icon128.png': 'png',
    'host/src/bridge.mjs': 'export {};',
    'scripts/build.mjs': 'export {};',
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    if (content === null) continue;
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe('checkProject on a clean fixture', () => {
  it('reports no problems when every referenced file exists and all scripts parse', () => {
    const { problems, scriptCount } = checkProject(makeFixture());
    assert.deepEqual(problems, []);
    assert.equal(scriptCount, 3);
  });
});

describe('manifest reference validation', () => {
  it('flags a missing icon referenced from icons', () => {
    const root = makeFixture({ files: { 'extension/icons/icon128.png': null } });
    const { problems } = checkProject(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /icons\[128\]|icons/);
    assert.match(problems[0], /extension\/icons\/icon128\.png/);
  });

  it('flags a missing service worker, side panel, and options page', () => {
    const root = makeFixture({
      files: { 'extension/src/background.js': null, 'extension/sidepanel.html': null, 'extension/options.html': null },
    });
    const text = checkProject(root).problems.join('\n');
    assert.match(text, /background\.service_worker.*extension\/src\/background\.js/);
    assert.match(text, /side_panel\.default_path.*extension\/sidepanel\.html/);
    assert.match(text, /options_page.*extension\/options\.html/);
  });

  it('reports a missing manifest.json', () => {
    const root = makeFixture({ files: { 'extension/manifest.json': null } });
    assert.match(checkProject(root).problems.join('\n'), /extension\/manifest\.json: missing/);
  });

  it('reports invalid manifest JSON', () => {
    const root = makeFixture({ manifest: '{ "name": ' });
    assert.match(checkProject(root).problems.join('\n'), /invalid JSON/);
  });

  it('rejects references that escape the extension folder', () => {
    const root = makeFixture({ manifest: { ...VALID_MANIFEST, options_page: '../scripts/build.mjs' } });
    assert.match(checkProject(root).problems.join('\n'), /escapes extension\/.*\.\.\/scripts\/build\.mjs/);
  });

  it('extracts content script and popup references', () => {
    const refs = manifestReferences({
      content_scripts: [{ js: ['a.js'], css: ['a.css'] }],
      action: { default_popup: 'popup.html' },
      options_ui: { page: 'opt.html' },
    });
    assert.deepEqual(refs.map((r) => r.path).sort(), ['a.css', 'a.js', 'opt.html', 'popup.html']);
  });
});

describe('syntax sweep', () => {
  it('detects a syntax error in a script under host/', () => {
    const root = makeFixture({ files: { 'host/src/bridge.mjs': 'const = ;' } });
    const problems = checkProject(root).problems;
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^host\/src\/bridge\.mjs: syntax error/);
  });

  it('ignores node_modules', () => {
    const root = makeFixture({ files: { 'extension/node_modules/x/bad.js': 'const = ;' } });
    assert.deepEqual(checkProject(root).problems, []);
  });
});

describe('check.mjs command line', () => {
  it('exits 0 on a clean fixture', () => {
    const result = spawnSync(process.execPath, [CHECK_SCRIPT, makeFixture()], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /check ok/);
  });

  it('exits 1 and lists the missing file on a broken fixture', () => {
    const root = makeFixture({ files: { 'extension/icons/icon16.png': null } });
    const result = spawnSync(process.execPath, [CHECK_SCRIPT, root], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /check failed: 1 problem/);
    assert.match(result.stderr, /extension\/icons\/icon16\.png/);
  });
});
