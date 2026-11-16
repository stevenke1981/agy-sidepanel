#!/usr/bin/env node
// Static checks for agy Bridge (zero dependencies):
//  1. `node --check` on every .js/.mjs/.cjs under extension/, host/, scripts/
//  2. extension/manifest.json parses and every file it references exists
// Usage: node scripts/check.mjs [projectRoot]   (exit 0 = clean, 1 = problems)

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');
const SCAN_DIRS = ['extension', 'host', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
const SCRIPT_FILE = /\.(?:m?js|cjs)$/;

export function listScriptFiles(root) {
  const found = [];
  for (const dir of SCAN_DIRS) walkScripts(join(root, dir), found);
  return found.sort();
}

function walkScripts(dir, found) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkScripts(full, found);
    } else if (entry.isFile() && SCRIPT_FILE.test(entry.name)) {
      found.push(full);
    }
  }
}

function firstLines(text, count = 3) {
  return (text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(0, count)
    .join(' | ');
}

export function checkSyntax(file, root) {
  const rel = relative(root, file).split(sep).join('/');
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.error) return `${rel}: cannot run node --check (${result.error.message})`;
  if (result.status !== 0) return `${rel}: syntax error: ${firstLines(result.stderr)}`;
  return null;
}

function addPaths(refs, field, value) {
  if (typeof value === 'string' && value !== '') refs.push({ field, path: value });
}

function addIconMap(refs, field, value) {
  if (typeof value === 'string') addPaths(refs, field, value);
  if (value && typeof value === 'object') {
    for (const [size, path] of Object.entries(value)) addPaths(refs, `${field}[${size}]`, path);
  }
}

function addContentScripts(refs, scripts) {
  (Array.isArray(scripts) ? scripts : []).forEach((cs, index) => {
    for (const kind of ['js', 'css']) {
      const list = Array.isArray(cs?.[kind]) ? cs[kind] : [];
      list.forEach((path) => addPaths(refs, `content_scripts[${index}].${kind}`, path));
    }
  });
}

/** Returns [{field, path}] for every file path the manifest points at. */
export function manifestReferences(manifest) {
  const refs = [];
  addPaths(refs, 'background.service_worker', manifest.background?.service_worker);
  addPaths(refs, 'side_panel.default_path', manifest.side_panel?.default_path);
  addPaths(refs, 'options_page', manifest.options_page);
  addPaths(refs, 'options_ui.page', manifest.options_ui?.page);
  addPaths(refs, 'action.default_popup', manifest.action?.default_popup);
  addIconMap(refs, 'action.default_icon', manifest.action?.default_icon);
  addIconMap(refs, 'icons', manifest.icons);
  addContentScripts(refs, manifest.content_scripts);
  return refs;
}

function checkRef(extDir, fields, path) {
  if (path.includes('*')) return [];
  const normalized = posix.normalize(path.replace(/\\/g, '/'));
  if (isAbsolute(path) || posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    return [`manifest ${fields}: path escapes extension/: ${path}`];
  }
  const abs = join(extDir, ...normalized.split('/'));
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return [`manifest ${fields}: referenced file missing: extension/${normalized}`];
  }
  return [];
}

/** Groups references by path so one missing file is reported once, listing every field that uses it. */
function groupByPath(refs) {
  const byPath = new Map();
  for (const { field, path } of refs) byPath.set(path, [...(byPath.get(path) ?? []), field]);
  return [...byPath].map(([path, fields]) => ({ path, fields: fields.join(', ') }));
}

export function checkManifest(root) {
  const extDir = join(root, 'extension');
  const file = join(extDir, 'manifest.json');
  if (!existsSync(file)) return ['extension/manifest.json: missing'];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    return [`extension/manifest.json: invalid JSON (${err.message})`];
  }
  return groupByPath(manifestReferences(manifest)).flatMap(({ path, fields }) => checkRef(extDir, fields, path));
}

export function checkProject(root = DEFAULT_ROOT) {
  const files = listScriptFiles(root);
  const syntaxProblems = files.map((file) => checkSyntax(file, root)).filter((p) => p !== null);
  return { problems: [...syntaxProblems, ...checkManifest(root)], scriptCount: files.length };
}

function main(argv) {
  const root = resolve(argv[2] ?? DEFAULT_ROOT);
  const { problems, scriptCount } = checkProject(root);
  if (problems.length > 0) {
    console.error(`check failed: ${problems.length} problem(s) in ${root}`);
    for (const problem of problems) console.error(` - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`check ok: ${scriptCount} script file(s) passed node --check; manifest references resolved`);
}

const isEntryPoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  try {
    main(process.argv);
  } catch (err) {
    console.error(`check error: ${err.message}`);
    process.exitCode = 1;
  }
}
