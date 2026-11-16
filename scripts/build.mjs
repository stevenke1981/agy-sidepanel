#!/usr/bin/env node
// Release packager for agy Bridge. Zero dependencies, cross-platform.
// Usage: node scripts/build.mjs [projectRoot]
// Output (<root>/dist): agy-bridge-v<ver>.zip, agy-bridge-extension-v<ver>.zip,
//                       SHA256SUMS.txt, build-manifest.json
// Exports the zip writer and allowlist so scripts/test can exercise them without running main.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');

const LOCAL_FILE_SIG = 0x04034b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;
const FLAG_UTF8_NAMES = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION_NEEDED = 20;
const MAX_ENTRIES = 0xffff;
const MAX_ARCHIVE_BYTES = 0xffffffff;
const DEFAULT_ZIP_TIME_MS = Date.UTC(2020, 0, 1);
const EXCLUDED_DIR_NAMES = new Set(['.git', 'node_modules', 'dist', 'test']);
const EXCLUDED_FILE_PATTERNS = [
  /\.test\.[cm]?js$/,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^\.env/,
  /\.log$/i,
  /^\.DS_Store$/,
  /^Thumbs\.db$/i,
];
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Explicit allowlist. Anything not listed here never reaches an artifact. */
export const RELEASE_RULES = Object.freeze({
  full: Object.freeze([
    { dir: 'extension' },
    { dir: 'host/src' },
    { file: 'host/agy-bridge.cmd.tpl' },
    { file: 'scripts/install.ps1' },
    { file: 'scripts/uninstall.ps1' },
    { file: 'README.md' },
    { file: 'LICENSE' },
    { file: 'CHANGELOG.md' },
  ]),
  // Extension-only artifact: archive root = contents of extension/ (manifest.json at root, Load-unpacked ready).
  extension: Object.freeze([{ dir: 'extension' }]),
});

export function isExcluded(name, isDirectory) {
  if (isDirectory) return EXCLUDED_DIR_NAMES.has(name);
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

// ---------- CRC-32 (IEEE, reflected) ----------

const CRC_TABLE = buildCrcTable();

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

export function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- ZIP writer (store or deflate, UTF-8 names, no zip64) ----------

export function resolveZipTime(env = process.env) {
  const raw = env.SOURCE_DATE_EPOCH;
  if (raw === undefined || raw === '') return new Date(DEFAULT_ZIP_TIME_MS);
  if (!/^\d+$/.test(raw)) throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer');
  return new Date(Number(raw) * 1000);
}

export function toDosDateTime(date) {
  const year = date.getUTCFullYear();
  if (year < 1980 || year > 2107) {
    throw new RangeError(`zip timestamp out of DOS range: ${date.toISOString()}`);
  }
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
}

export function assertArchiveName(name) {
  const segments = name.split('/');
  const unsafe =
    name.length === 0 ||
    name.startsWith('/') ||
    name.includes('\\') ||
    /^[A-Za-z]:/.test(name) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..');
  if (unsafe) throw new Error(`unsafe archive path: ${name}`);
  return name;
}

function encodeEntry(entry, dos) {
  const name = Buffer.from(assertArchiveName(entry.name), 'utf8');
  const data = Buffer.from(entry.data);
  if (data.length >= MAX_ARCHIVE_BYTES) throw new RangeError(`entry too large for zip32: ${entry.name}`);
  const deflated = deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  return {
    name,
    dos,
    crc: crc32(data),
    method: useDeflate ? METHOD_DEFLATE : METHOD_STORE,
    payload: useDeflate ? deflated : data,
    size: data.length,
  };
}

function localHeader(e) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(LOCAL_FILE_SIG, 0);
  h.writeUInt16LE(VERSION_NEEDED, 4);
  h.writeUInt16LE(FLAG_UTF8_NAMES, 6);
  h.writeUInt16LE(e.method, 8);
  h.writeUInt16LE(e.dos.time, 10);
  h.writeUInt16LE(e.dos.day, 12);
  h.writeUInt32LE(e.crc, 14);
  h.writeUInt32LE(e.payload.length, 18);
  h.writeUInt32LE(e.size, 22);
  h.writeUInt16LE(e.name.length, 26);
  h.writeUInt16LE(0, 28);
  return h;
}

function centralHeader(e, localOffset) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(CENTRAL_DIR_SIG, 0);
  h.writeUInt16LE(VERSION_NEEDED, 4);
  h.writeUInt16LE(VERSION_NEEDED, 6);
  h.writeUInt16LE(FLAG_UTF8_NAMES, 8);
  h.writeUInt16LE(e.method, 10);
  h.writeUInt16LE(e.dos.time, 12);
  h.writeUInt16LE(e.dos.day, 14);
  h.writeUInt32LE(e.crc, 16);
  h.writeUInt32LE(e.payload.length, 20);
  h.writeUInt32LE(e.size, 24);
  h.writeUInt16LE(e.name.length, 28);
  h.writeUInt32LE(localOffset, 42);
  return h;
}

function endOfCentralDir(count, cdSize, cdOffset) {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(END_OF_CENTRAL_DIR_SIG, 0);
  h.writeUInt16LE(count, 8);
  h.writeUInt16LE(count, 10);
  h.writeUInt32LE(cdSize, 12);
  h.writeUInt32LE(cdOffset, 16);
  return h;
}

/** entries: [{ name: 'a/b.txt', data: Buffer|Uint8Array|string }] -> Buffer (zip archive). */
export function buildZip(entries, { time = new Date(DEFAULT_ZIP_TIME_MS) } = {}) {
  if (entries.length > MAX_ENTRIES) throw new RangeError('too many entries for zip32');
  const dos = toDosDateTime(time);
  const encoded = entries.map((entry) => encodeEntry(entry, dos));
  const body = [];
  const central = [];
  let offset = 0;
  for (const e of encoded) {
    const local = localHeader(e);
    central.push(centralHeader(e, offset), e.name);
    body.push(local, e.name, e.payload);
    offset += local.length + e.name.length + e.payload.length;
  }
  const centralBuf = Buffer.concat(central);
  if (offset >= MAX_ARCHIVE_BYTES) throw new RangeError('archive too large for zip32');
  return Buffer.concat([...body, centralBuf, endOfCentralDir(encoded.length, centralBuf.length, offset)]);
}

// ---------- file selection ----------

function listFilesUnder(root, relDir) {
  const out = [];
  const walk = (rel) => {
    const entries = readdirSync(join(root, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childRel = `${rel}/${entry.name}`;
      if (isExcluded(entry.name, entry.isDirectory())) continue;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) out.push(childRel);
      else throw new Error(`unsupported entry (symlink or special file): ${childRel}`);
    }
  };
  walk(relDir);
  return out;
}

export function collectReleaseFiles(root, rules) {
  const files = new Set();
  for (const rule of rules) {
    if (rule.file) {
      if (!isFile(join(root, rule.file))) throw new Error(`missing release input: ${rule.file}`);
      files.add(rule.file);
    } else if (rule.dir) {
      if (!isDirectory(join(root, rule.dir))) throw new Error(`missing release directory: ${rule.dir}`);
      for (const rel of listFilesUnder(root, rule.dir)) files.add(rel);
    }
  }
  return [...files].sort();
}

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory();
}

// ---------- release assembly ----------

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`cannot read JSON ${path}: ${err.message}`);
  }
}

export function assertSameVersion(packageVersion, manifestVersion) {
  if (typeof manifestVersion !== 'string' || !VERSION_PATTERN.test(manifestVersion)) {
    throw new Error(`extension/manifest.json has an invalid version: ${manifestVersion}`);
  }
  if (packageVersion !== manifestVersion) {
    throw new Error(`version mismatch: package.json=${packageVersion} extension/manifest.json=${manifestVersion}`);
  }
  return manifestVersion;
}

function archiveName(rel, stripPrefix) {
  return stripPrefix && rel.startsWith(stripPrefix) ? rel.slice(stripPrefix.length) : rel;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function writeArtifact({ root, outDir, name, files, stripPrefix, time }) {
  const entries = files.map((rel) => ({
    name: archiveName(rel, stripPrefix),
    data: readFileSync(join(root, rel)),
  }));
  const zip = buildZip(entries, { time });
  writeFileSync(join(outDir, name), zip);
  return { name, bytes: zip.length, sha256: sha256(zip), entries: entries.map((e) => e.name) };
}

function sumsText(artifacts) {
  return artifacts.map((a) => `${a.sha256}  ${a.name}`).join('\n') + '\n';
}

function gitHead(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function buildManifestDoc(root, version, artifacts) {
  return {
    name: 'agy-bridge',
    version,
    source_commit: gitHead(root),
    signed: false,
    signing_note: 'Artifacts are not code-signed. SHA256SUMS.txt is the only integrity evidence.',
    requirements: { os: 'Windows 10/11 for install.ps1; Chrome 116+', node: '>=20' },
    artifacts,
  };
}

/** Builds both zips, SHA256SUMS.txt and build-manifest.json into outDir (wiped first). */
export function buildRelease({ root = DEFAULT_ROOT, outDir = join(root, 'dist'), time = resolveZipTime() } = {}) {
  const pkg = readJsonFile(join(root, 'package.json'));
  const manifest = readJsonFile(join(root, 'extension', 'manifest.json'));
  const version = assertSameVersion(pkg.version, manifest.version);
  if (resolve(outDir) === resolve(root)) throw new Error('outDir must not be the project root');
  const fullFiles = collectReleaseFiles(root, RELEASE_RULES.full);
  const extFiles = collectReleaseFiles(root, RELEASE_RULES.extension);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const artifacts = [
    writeArtifact({ root, outDir, name: `agy-bridge-v${version}.zip`, files: fullFiles, stripPrefix: '', time }),
    writeArtifact({
      root,
      outDir,
      name: `agy-bridge-extension-v${version}.zip`,
      files: extFiles,
      stripPrefix: 'extension/',
      time,
    }),
  ];
  writeFileSync(join(outDir, 'SHA256SUMS.txt'), sumsText(artifacts));
  writeFileSync(join(outDir, 'build-manifest.json'), JSON.stringify(buildManifestDoc(root, version, artifacts), null, 2) + '\n');
  return { version, artifacts, outDir };
}

function main(argv) {
  const root = resolve(argv[2] ?? DEFAULT_ROOT);
  const result = buildRelease({ root });
  for (const a of result.artifacts) {
    console.log(`${a.sha256}  ${a.name}  (${a.bytes} bytes, ${a.entries.length} entries)`);
  }
  console.log(`wrote ${result.outDir}`);
}

const isEntryPoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  try {
    main(process.argv);
  } catch (err) {
    console.error(`build failed: ${err.message}`);
    process.exitCode = 1;
  }
}
