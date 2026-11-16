// Shared contract between the extension and the native host (host imports this file).
// Pure ES module: no chrome.* or node:* references, so both sides and node:test can import it.

export const HOST_NAME = 'com.agy.bridge';
export const EXTENSION_ID = 'dnildepikbjklalofggmgafohplflpgg';
export const PROTOCOL_VERSION = 1;

/** Requests: extension -> host */
export const REQ = Object.freeze({
  HELLO: 'hello',     // {type, protocol}
  MODELS: 'models',   // {type, reqId}
  RUN: 'run',         // {type, reqId, prompt, options: RunOptions}
  CANCEL: 'cancel',   // {type, reqId}
  OPEN_IDE: 'openIde' // {type, reqId, path}
});

/** Responses: host -> extension */
export const RES = Object.freeze({
  HELLO: 'hello',         // {type, protocol, hostVersion, agyPath, agyVersion, ideAvailable, defaultCwd}
  MODELS: 'models',       // {type, reqId, models: [{id, label}]}
  EVENT: 'event',         // {type, reqId, event: <one parsed agy stream-json line>}
  STDERR: 'stderr',       // {type, reqId, text}
  EXIT: 'exit',           // {type, reqId, code, signal, cancelled:boolean} — exactly ONE per accepted RUN, always last
  CANCELLED: 'cancelled', // {type, reqId} — ack only; EXIT{cancelled:true} still follows
  OK: 'ok',               // {type, reqId}
  ERROR: 'error'          // {type, reqId|null, code: ERR.*, message}
});

export const ERR = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
  AGY_NOT_FOUND: 'AGY_NOT_FOUND',
  IDE_NOT_FOUND: 'IDE_NOT_FOUND',
  TOO_MANY_RUNS: 'TOO_MANY_RUNS',
  UNKNOWN_RUN: 'UNKNOWN_RUN',
  SPAWN_FAILED: 'SPAWN_FAILED',
  DUPLICATE_REQ: 'DUPLICATE_REQ',
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
  INTERNAL: 'INTERNAL'
});

// Terminal-state contract:
// - A RUN that fails validation gets ERROR (no EXIT).
// - A RUN accepted then failing to spawn gets ERROR{SPAWN_FAILED} followed by EXIT{code:null}.
// - Every accepted RUN ends with exactly one EXIT, which is the last message for that reqId.
// - Oversize events (> MAX_HOST_MESSAGE_BYTES after byte-aware truncation of text fields) are replaced by
//   EVENT{event:{event:'oversize', originalEvent:<name>, bytes}}.

export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const MODES = Object.freeze(['plan', 'accept-edits', 'auto']);

export const LIMITS = Object.freeze({
  MAX_PROMPT_CHARS: 400_000,
  MAX_CONCURRENT_RUNS: 3,
  MAX_HOST_MESSAGE_BYTES: 1_000_000, // Chrome rejects host->extension messages > 1 MB
  MAX_REQ_ID_CHARS: 64,
  DEFAULT_CONTEXT_CHARS: 20_000,
  MAX_LINE_BYTES: 4_000_000,         // host discards (and reports) stdout lines longer than this
  RUN_IDLE_TIMEOUT_MS: 10 * 60_000   // host kills a run with no output for this long
});

// First char must be alphanumeric so values can never be parsed as CLI flags.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REQ_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const UUID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;
// Drive-letter absolute path only: rejects UNC (\\server), device (\\?\ \\.\), relative and '-'-prefixed.
const DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/;

/** Default user settings (chrome.storage.local key "settings"). */
export const DEFAULT_SETTINGS = Object.freeze({
  model: '',               // '' = agy default
  effort: '',              // '' = agy default
  mode: 'plan',            // safest default
  cwd: '',                 // '' = host default %LOCALAPPDATA%\agy-bridge\workspace (NOT home)
  // skipPermissions is NOT persisted here: it lives in chrome.storage.session (key "skipPermissions").
  includePageContext: true,
  maxContextChars: LIMITS.DEFAULT_CONTEXT_CHARS
});

/**
 * Validate RunOptions. Returns {ok:true, value} with a normalized copy or {ok:false, message}.
 * RunOptions: {model?, effort?, mode?, cwd?, conversationId?, skipPermissions?, hasPageContext?}
 * When hasPageContext is true, skipPermissions and mode 'auto' are rejected (prompt-injection guard).
 */
export function validateRunOptions(options) {
  const o = options ?? {};
  if (typeof o !== 'object' || Array.isArray(o)) return fail('options must be an object');
  const out = {};
  if (o.model) {
    if (typeof o.model !== 'string' || !MODEL_RE.test(o.model)) return fail('invalid model');
    out.model = o.model;
  }
  if (o.effort) {
    if (!EFFORTS.includes(o.effort)) return fail('invalid effort');
    out.effort = o.effort;
  }
  if (o.mode) {
    if (!MODES.includes(o.mode)) return fail('invalid mode');
    out.mode = o.mode;
  }
  if (o.cwd) {
    if (!isSafeAbsolutePath(o.cwd)) return fail('invalid cwd');
    out.cwd = o.cwd;
  }
  if (o.conversationId) {
    if (typeof o.conversationId !== 'string' || !UUID_RE.test(o.conversationId)) return fail('invalid conversationId');
    out.conversationId = o.conversationId;
  }
  out.skipPermissions = o.skipPermissions === true;
  out.hasPageContext = o.hasPageContext === true;
  if (out.hasPageContext && (out.skipPermissions || out.mode === 'auto')) {
    return fail('page context cannot be combined with skipPermissions or auto mode');
  }
  return { ok: true, value: out };
}

/** Windows drive-letter absolute path, no NUL, no '..' segments, <= 1024 chars. */
export function isSafeAbsolutePath(p) {
  if (typeof p !== 'string' || p.length > 1024 || p.includes('\u0000')) return false;
  if (!DRIVE_PATH_RE.test(p)) return false;
  return !p.split(/[\\/]/).includes('..');
}

export function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.trim() === '') return fail('prompt must be a non-empty string');
  if (prompt.length > LIMITS.MAX_PROMPT_CHARS) return fail('prompt too long');
  return { ok: true, value: prompt };
}

export function validateOpenIdePath(path) {
  return isSafeAbsolutePath(path) ? { ok: true, value: path } : fail('invalid path');
}

export function isValidReqId(reqId) {
  return typeof reqId === 'string' && REQ_ID_RE.test(reqId);
}

function fail(message) {
  return { ok: false, message };
}
