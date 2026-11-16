// Release assembly: allowlist, exclusions, version lock, SHA256SUMS. Runs against temp fixture roots.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { assertSameVersion, buildRelease, isExcluded } from '../build.mjs';
import { parseZip } from './support/zip-reader.mjs';

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const FILES = {
  'package.json': JSON.stringify({ name: 'fixture', version: '1.2.3', private: true }),
  'extension/manifest.json': JSON.stringify({ manifest_version: 3, name: 'x', version: '1.2.3' }),
  'extension/src/lib/protocol.js': 'export const A = 1;',
  'extension/src/background.js': 'export {};',
  'extension/test/protocol.test.js': 'import "node:test";',
  'extension/leak.pem': '-----BEGIN PRIVATE KEY-----',
  'extension/src/.DS_Store': 'junk',
  'host/src/bridge.mjs': 'export {};',
  'host/src/framing.mjs': 'export {};',
  'host/test/bridge.test.mjs': 'import "node:test";',
  'host/agy-bridge.cmd.tpl': '@echo off\r\n"{{NODE}}" "%~dp0src\\bridge.mjs" %*\r\n',
  'scripts/install.ps1': '# install',
  'scripts/uninstall.ps1': '# uninstall',
  'scripts/test/check.test.mjs': 'import "node:test";',
  'scripts/build.mjs': 'export {};',
  'README.md': '# readme',
  'LICENSE': 'MIT',
  'CHANGELOG.md': '## 1.2.3',
  '.git/HEAD': 'ref: refs/heads/main',
  'node_modules/dep/index.js': 'module.exports = 1;',
  'dist/stale-agy-bridge-v0.0.1.zip': 'stale',
  '.env': 'SECRET=1',
};

function makeFixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agyb-build-'));
  tempDirs.push(root);
  const files = { ...FILES, ...overrides };
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function zipNames(path) {
  return parseZip(readFileSync(path)).map((e) => e.name);
}

describe('exclusion rules', () => {
  it('excludes test folders, git, node_modules, dist, keys and env-like files', () => {
    assert.equal(isExcluded('test', true), true);
    assert.equal(isExcluded('.git', true), true);
    assert.equal(isExcluded('node_modules', true), true);
    assert.equal(isExcluded('dist', true), true);
    assert.equal(isExcluded('x.test.js', false), true);
    assert.equal(isExcluded('x.test.mjs', false), true);
    assert.equal(isExcluded('cert.pem', false), true);
    assert.equal(isExcluded('.env.local', false), true);
    assert.equal(isExcluded('bridge.mjs', false), false);
    assert.equal(isExcluded('install.ps1', false), false);
  });
});

describe('version lock', () => {
  it('returns the shared version when package.json and manifest agree', () => {
    assert.equal(assertSameVersion('1.2.3', '1.2.3'), '1.2.3');
  });

  it('throws on mismatch', () => {
    assert.throws(() => assertSameVersion('1.2.4', '1.2.3'), /version mismatch/);
  });

  it('throws on a malformed version', () => {
    assert.throws(() => assertSameVersion('1.2', '1.2'), /invalid version/);
  });
});

describe('buildRelease', () => {
  it('full zip holds only allowlisted content (no test, git, node_modules, dist, pem, env)', () => {
    const root = makeFixture();
    const result = buildRelease({ root, time: new Date(Date.UTC(2024, 0, 1)) });
    assert.equal(result.version, '1.2.3');
    assert.deepEqual(zipNames(join(root, 'dist', 'agy-bridge-v1.2.3.zip')), [
      'CHANGELOG.md',
      'LICENSE',
      'README.md',
      'extension/manifest.json',
      'extension/src/background.js',
      'extension/src/lib/protocol.js',
      'host/agy-bridge.cmd.tpl',
      'host/src/bridge.mjs',
      'host/src/framing.mjs',
      'scripts/install.ps1',
      'scripts/uninstall.ps1',
    ]);
  });

  it('extension-only zip has extension files at its root', () => {
    const root = makeFixture();
    buildRelease({ root });
    assert.deepEqual(zipNames(join(root, 'dist', 'agy-bridge-extension-v1.2.3.zip')), [
      'manifest.json',
      'src/background.js',
      'src/lib/protocol.js',
    ]);
  });

  it('writes SHA256SUMS.txt that matches the real artifact hashes', () => {
    const root = makeFixture();
    buildRelease({ root });
    const lines = readFileSync(join(root, 'dist', 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const match = /^([0-9a-f]{64})  (agy-bridge(?:-extension)?-v1\.2\.3\.zip)$/.exec(line);
      assert.ok(match, `bad SHA256SUMS line: ${line}`);
      const actual = createHash('sha256').update(readFileSync(join(root, 'dist', match[2]))).digest('hex');
      assert.equal(actual, match[1]);
    }
  });

  it('writes build-manifest.json marking artifacts unsigned with requirements', () => {
    const root = makeFixture();
    buildRelease({ root });
    const doc = JSON.parse(readFileSync(join(root, 'dist', 'build-manifest.json'), 'utf8'));
    assert.equal(doc.version, '1.2.3');
    assert.equal(doc.signed, false);
    assert.equal(doc.requirements.node, '>=20');
    assert.equal(doc.artifacts.length, 2);
  });

  it('wipes stale files from dist before writing', () => {
    const root = makeFixture();
    buildRelease({ root });
    assert.throws(() => readFileSync(join(root, 'dist', 'stale-agy-bridge-v0.0.1.zip')), /ENOENT/);
  });

  it('fails when a required release input such as CHANGELOG.md is missing', () => {
    const root = makeFixture({ 'CHANGELOG.md': null });
    assert.throws(() => buildRelease({ root }), /missing release input: CHANGELOG\.md/);
  });

  it('fails on a version mismatch', () => {
    const root = makeFixture({ 'package.json': JSON.stringify({ version: '9.9.9' }) });
    assert.throws(() => buildRelease({ root }), /version mismatch/);
  });
});
