// Shared contract between the extension and the native host (host imports this file).
// Pure ES module: no chrome.* or node:* references, so both sides and node:test can import it.

export const HOST_NAME = 'com.agy.bridge';
export const EXTENSION_ID = 'dnildepikbjklalofggmgafohplflpgg';
export const PROTOCOL_VERSION = 1;

/** Requests: extension -> host */
export const REQ = Object.freeze({
  HELLO: 'hello',     // {type}
  MODELS: 'models',   // {type, reqId}
  RUN: 'run',         // {type, reqId, prompt, options: RunOptions}
  CANCEL: 'cancel',   // {type, reqId}
  OPEN_IDE: 'openIde' // {type, reqId, path}
});

/** Responses: host -> extension */
export const RES = Object.freeze({
  HELLO: 'hello',         // {type, protocol, hostVersion, agyPath, agyVersion, ideAvailable}
  MODELS: 'models',       // {type, reqId, models: [{id, label}]}
  EVENT: 'event',         // {type, reqId, event: <one parsed agy stream-json line>}
  STDERR: 'stderr',       // {type, reqId, text}
  EXIT: 'exit',           // {type, reqId, code, signal}
  CANCELLED: 'cancelled', // {type, reqId}
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
  INTERNAL: 'INTERNAL'
});

export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const MODES = Object.freeze(['plan', 'accept-edits', 'auto']);

export const LIMITS = Object.freeze({
  MAX_PROMPT_CHARS: 400_000,
  MAX_CONCURRENT_RUNS: 3,
  MAX_HOST_MESSAGE_BYTES: 1_000_000, // Chrome rejects host->extension messages > 1 MB
  MAX_REQ_ID_CHARS: 64,
  DEFAULT_CONTEXT_CHARS: 20_000
});

const MODEL_RE = /^[A-Za-z0-9._-]{1,80}$/;
const REQ_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-fA-F-]{8,64}$/;

/** Default user settings (chrome.storage.local key "settings"). */
export const DEFAULT_SETTINGS = Object.freeze({
  model: '',               // '' = agy default
  effort: '',              // '' = agy default
  mode: 'plan',            // safest default
  cwd: '',                 // '' = host default (user home)
  skipPermissions: false,  // maps to --dangerously-skip-permissions; opt-in only
  includePageContext: true,
  maxContextChars: LIMITS.DEFAULT_CONTEXT_CHARS
});

/**
 * Validate RunOptions. Returns {ok:true, value} with a normalized copy or {ok:false, message}.
 * RunOptions: {model?, effort?, mode?, cwd?, conversationId?, skipPermissions?}
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
    if (typeof o.cwd !== 'string' || o.cwd.length > 1024 || o.cwd.includes('\0')) return fail('invalid cwd');
    out.cwd = o.cwd;
  }
  if (o.conversationId) {
    if (typeof o.conversationId !== 'string' || !UUID_RE.test(o.conversationId)) return fail('invalid conversationId');
    out.conversationId = o.conversationId;
  }
  out.skipPermissions = o.skipPermissions === true;
  return { ok: true, value: out };
}

export function isValidReqId(reqId) {
  return typeof reqId === 'string' && REQ_ID_RE.test(reqId);
}

function fail(message) {
  return { ok: false, message };
}
