// agy CLI helpers: path resolution, argument building, model parsing, IDE discovery,
// workspace selection and the host-to-extension 1 MB size rule.
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '../../extension/src/lib/protocol.js';

const AGY_EXE_NAMES = Object.freeze(['agy.exe', 'agy']);
const IDE_DIR_SEGMENTS = Object.freeze(['Programs', 'Antigravity IDE']);
const IDE_EXE_NAME = 'Antigravity IDE.exe';
const IDE_CLI_SEGMENTS = Object.freeze(['resources', 'app', 'out', 'cli.js']);
const TEXT_KEYS = Object.freeze(['text_delta', 'response', 'text']);
const TRUNCATE_MARGIN_BYTES = 64;
const win = path.win32;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Resolution order: AGY_PATH, %LOCALAPPDATA%\agy\bin\agy.exe, then PATH (agy.exe, then agy). */
export function resolveAgyPath({ env = process.env, fsExists = existsSync } = {}) {
  const fromEnv = env.AGY_PATH;
  if (fromEnv && fsExists(fromEnv)) return fromEnv;
  const localDefault = env.LOCALAPPDATA ? win.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : null;
  if (localDefault && fsExists(localDefault)) return localDefault;
  return searchPath(env.PATH ?? env.Path ?? '', fsExists);
}

function searchPath(pathVar, fsExists) {
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of AGY_EXE_NAMES) {
      const candidate = path.join(dir, name);
      if (fsExists(candidate)) return candidate;
    }
  }
  return null;
}

/** @param {{model?:string,effort?:string,mode?:string,conversationId?:string,skipPermissions?:boolean}} options validated options */
export function buildArgs(options) {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print='];
  const valued = [
    ['--model=', options.model],
    ['--effort=', options.effort],
    ['--mode=', options.mode],
    ['--conversation=', options.conversationId],
  ];
  for (const [prefix, value] of valued) {
    if (value) args.push(`${prefix}${value}`);
  }
  if (options.skipPermissions === true) args.push('--dangerously-skip-permissions');
  return args;
}

export function buildStdinPayload(prompt) {
  return `${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } })}\n`;
}

function parseModelLine(line) {
  const tab = line.indexOf('\t');
  if (tab === -1) return [];
  const id = line.slice(0, tab).trim();
  if (id === '') return [];
  const label = line.slice(tab + 1).trim();
  return [{ id, label: label || id }];
}

/** Lines containing a TAB are `<id>\t<label>`; anything else (e.g. "Fetching available models...") is skipped. */
export function parseModels(stdout) {
  return String(stdout ?? '').split(/\r?\n/).flatMap(parseModelLine);
}

/** @returns {{exe: string, cliJs: string} | null} */
export function resolveIde({ env = process.env, fsExists = existsSync } = {}) {
  if (!env.LOCALAPPDATA) return null;
  const dir = win.join(env.LOCALAPPDATA, ...IDE_DIR_SEGMENTS);
  const exe = win.join(dir, IDE_EXE_NAME);
  const cliJs = win.join(dir, ...IDE_CLI_SEGMENTS);
  return fsExists(exe) && fsExists(cliJs) ? { exe, cliJs } : null;
}

/** Creates (recursively) and returns %LOCALAPPDATA%\agy-bridge\workspace. Throws when LOCALAPPDATA is unset. */
export function defaultCwd({ env = process.env, mkdirSync: makeDir = mkdirSync } = {}) {
  if (!env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is not set; cannot choose a default workspace');
  const dir = win.join(env.LOCALAPPDATA, 'agy-bridge', 'workspace');
  makeDir(dir, { recursive: true });
  return dir;
}

const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Keeps a host->extension message within `limit` UTF-8 bytes (Chrome rejects > 1 MB).
 * Text fields (text_delta / response / text) of msg.event and its direct child objects are
 * cut on code-point boundaries and marked truncated:true. If the message still does not fit,
 * it is replaced by EVENT{event:{event:'oversize', originalEvent, bytes}}.
 */
export function truncateForHost(msg, limit = LIMITS.MAX_HOST_MESSAGE_BYTES) {
  const size = jsonBytes(msg);
  if (size <= limit) return msg;
  const fitted = fitTextFields(msg, limit);
  return jsonBytes(fitted) <= limit ? fitted : oversizeReplacement(msg, size);
}

function fitTextFields(msg, limit) {
  let next = msg;
  for (const keyPath of textFieldPaths(msg)) {
    const excess = jsonBytes(next) - limit;
    if (excess <= 0) break;
    next = cutTextField(next, keyPath, excess);
  }
  return next;
}

function textFieldPaths(msg) {
  const base = isPlainObject(msg.event) ? ['event'] : [];
  const container = getIn(msg, base);
  const direct = TEXT_KEYS.filter((key) => typeof container[key] === 'string')
    .map((key) => [...base, key]);
  const nested = Object.keys(container)
    .filter((key) => isPlainObject(container[key]))
    .flatMap((key) => TEXT_KEYS.filter((text) => typeof container[key][text] === 'string')
      .map((text) => [...base, key, text]));
  return [...direct, ...nested];
}

function cutTextField(msg, keyPath, excess) {
  const text = getIn(msg, keyPath);
  const keep = Math.max(0, Buffer.byteLength(text, 'utf8') - excess - TRUNCATE_MARGIN_BYTES);
  const parentPath = keyPath.slice(0, -1);
  const key = keyPath[keyPath.length - 1];
  const parent = getIn(msg, parentPath);
  return setIn(msg, parentPath, { ...parent, [key]: truncateUtf8(text, keep), truncated: true });
}

function truncateUtf8(text, maxBytes) {
  let used = 0;
  let out = '';
  for (const ch of text) {
    const bytes = Buffer.byteLength(ch, 'utf8');
    if (used + bytes > maxBytes) break;
    used += bytes;
    out += ch;
  }
  return out;
}

function oversizeReplacement(msg, size) {
  const originalEvent = isPlainObject(msg.event) ? msg.event.event : msg.type;
  return {
    type: msg.type,
    reqId: msg.reqId ?? null,
    event: { event: 'oversize', originalEvent: String(originalEvent ?? 'unknown'), bytes: size },
  };
}

function getIn(obj, keys) {
  return keys.reduce((node, key) => node[key], obj);
}

function setIn(obj, keys, value) {
  if (keys.length === 0) return value;
  const [head, ...rest] = keys;
  return { ...obj, [head]: setIn(obj[head], rest, value) };
}
