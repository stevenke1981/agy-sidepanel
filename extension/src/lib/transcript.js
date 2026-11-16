// Pure transcript reducer for the side panel. Every update returns a new state; no chrome.* access.
import { ERR, RES } from './protocol.js';

export const MAX_STDERR_CHARS = 4000;
export const MAX_NOTE_CHARS = 500;
export const MAX_TOOL_INFO_CHARS = 300;

/**
 * @typedef {'running'|'done'|'error'|'cancelled'} RunPhase
 * @typedef {{reqId: string, phase: RunPhase, cancelled: boolean, exitCode: number|null, signal: string|null,
 *   resultStatus: string|null, usage: object|null, error: string|null, stderr: string,
 *   durationSeconds: number|null, numTurns: number|null}} RunInfo
 * @typedef {{id: number, kind: 'user', reqId: string|null, text: string, context: object|null}
 *   | {id: number, kind: 'assistant', reqId: string, text: string, truncated: boolean}
 *   | {id: number, kind: 'step', reqId: string, stepIndex: number|null, stepType: string, toolName: string,
 *      toolInfo: string, state: string, durationSeconds: number|null}
 *   | {id: number, kind: 'note', reqId: string|null, text: string}} Row
 * @typedef {{conversationId: string|null, init: {model: string, permissionMode: string, toolCount: number,
 *   cwd: string}|null, rows: Row[], runs: Record<string, RunInfo>, nextId: number,
 *   lastError: {code: string, message: string}|null}} TranscriptState
 */

/** @returns {TranscriptState} */
export function initialState() {
  return { conversationId: null, init: null, rows: [], runs: {}, nextId: 1, lastError: null };
}

/** Clear the conversation. Callers should cancel any running run first; late messages for old reqIds are ignored.
 * @returns {TranscriptState} */
export function newConversation() {
  return initialState();
}

/** @param {unknown} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v : '';
}

/** @param {unknown} v @returns {number|null} */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** @param {string} text @param {number} [max] @returns {string} */
function clip(text, max = MAX_NOTE_CHARS) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** @param {unknown} v @returns {string} */
function toolInfoText(v) {
  if (v === undefined || v === null) return '';
  let text = '';
  if (typeof v === 'string') text = v;
  else {
    try {
      text = JSON.stringify(v) ?? '';
    } catch {
      text = '[unserializable tool info]';
    }
  }
  return clip(text, MAX_TOOL_INFO_CHARS);
}

/** @param {TranscriptState} state @param {Row} row @returns {TranscriptState} */
function appendRow(state, row) {
  return { ...state, rows: [...state.rows, { ...row, id: state.nextId }], nextId: state.nextId + 1 };
}

/** @param {TranscriptState} state @param {number} index @param {object} patch @returns {TranscriptState} */
function patchRow(state, index, patch) {
  return { ...state, rows: state.rows.map((r, i) => (i === index ? { ...r, ...patch } : r)) };
}

/** @param {TranscriptState} state @param {unknown} reqId @returns {boolean} */
function hasRun(state, reqId) {
  return typeof reqId === 'string' && Object.hasOwn(state.runs, reqId);
}

/** @param {TranscriptState} state @param {string} reqId @param {object} patch @returns {TranscriptState} */
function patchRun(state, reqId, patch) {
  if (!hasRun(state, reqId)) return state;
  return { ...state, runs: { ...state.runs, [reqId]: { ...state.runs[reqId], ...patch } } };
}

/** @param {TranscriptState} state @param {string|null} reqId @param {string} text @returns {TranscriptState} */
function note(state, reqId, text) {
  return appendRow(state, { kind: 'note', reqId: reqId ?? null, text: clip(text) });
}

/** @param {string} reqId @returns {RunInfo} */
function initialRun(reqId) {
  return {
    reqId, phase: 'running', cancelled: false, exitCode: null, signal: null, resultStatus: null,
    usage: null, error: null, stderr: '', durationSeconds: null, numTurns: null,
  };
}

/** @param {TranscriptState} state @param {string} reqId @returns {TranscriptState} */
function bindLastUserRow(state, reqId) {
  const index = findLastIndex(state.rows, (r) => r.kind === 'user' && r.reqId === null);
  return index === -1 ? state : patchRow(state, index, { reqId });
}

/** @template T @param {T[]} list @param {(item: T) => boolean} predicate @returns {number} */
function findLastIndex(list, predicate) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (predicate(list[i])) return i;
  }
  return -1;
}

/**
 * Append a user message. Context is stored as metadata only (title, url, chars), never the page text.
 * @param {TranscriptState} state
 * @param {string} text
 * @param {{title: string, url: string, chars: number}|null} [contextSummary]
 * @returns {TranscriptState}
 */
export function addUserMessage(state, text, contextSummary = null) {
  const context = contextSummary
    ? { title: str(contextSummary.title), url: str(contextSummary.url), chars: num(contextSummary.chars) ?? 0 }
    : null;
  return appendRow(state, { kind: 'user', reqId: null, text: str(text), context });
}

/**
 * Register a run and bind the most recent unbound user message to it.
 * @param {TranscriptState} state
 * @param {string} reqId
 * @returns {TranscriptState}
 */
export function startRun(state, reqId) {
  if (typeof reqId !== 'string' || hasRun(state, reqId)) return state;
  const withRun = { ...state, runs: { ...state.runs, [reqId]: initialRun(reqId) } };
  return bindLastUserRow(withRun, reqId);
}

/**
 * True while any run has not received EXIT. Use it to disable the send button.
 * @param {TranscriptState} state
 * @returns {boolean}
 */
export function hasActiveRun(state) {
  return Object.values(state.runs).some((r) => r.phase === 'running');
}

/**
 * Apply one host -> extension message. Messages for unknown reqIds (e.g. after newConversation) are ignored.
 * @param {TranscriptState} state
 * @param {object} msg
 * @returns {TranscriptState}
 */
export function applyHostMessage(state, msg) {
  if (!msg || typeof msg !== 'object') return state;
  switch (msg.type) {
    case RES.EVENT: return hasRun(state, msg.reqId) ? onEvent(state, msg.reqId, msg) : state;
    case RES.STDERR: return hasRun(state, msg.reqId) ? onStderr(state, msg.reqId, msg.text) : state;
    case RES.EXIT: return hasRun(state, msg.reqId) ? onExit(state, msg.reqId, msg) : state;
    case RES.ERROR: return onError(state, msg);
    default: return state; // hello, models, ok and cancelled acks are handled by the caller
  }
}

/** @param {TranscriptState} state @param {string} reqId @param {object} msg @returns {TranscriptState} */
function onEvent(state, reqId, msg) {
  const ev = msg.event;
  if (!ev || typeof ev !== 'object') return note(state, reqId, 'malformed event');
  switch (ev.event) {
    case 'init': return onInit(state, ev);
    case 'step_update': return onStepUpdate(state, reqId, ev);
    case 'result': return onResult(state, reqId, ev);
    case 'oversize': return note(state, reqId, `output too large: ${str(ev.originalEvent)} (${num(ev.bytes) ?? '?'} bytes), skipped`);
    default: return note(state, reqId, unknownEventText(ev));
  }
}

/** @param {object} ev @returns {string} */
function unknownEventText(ev) {
  const name = str(ev.event) || 'unknown';
  return `event ${name}: ${toolInfoText(ev)}`;
}

/** @param {TranscriptState} state @param {object} ev @returns {TranscriptState} */
function onInit(state, ev) {
  const init = ev.init && typeof ev.init === 'object' ? ev.init : {};
  return {
    ...state,
    conversationId: str(ev.conversation_id) || state.conversationId,
    init: {
      model: str(init.model),
      permissionMode: str(init.permission_mode),
      toolCount: Array.isArray(init.tools) ? init.tools.length : 0,
      cwd: str(init.cwd),
    },
  };
}

/** @param {object} ev @param {object} inner @returns {boolean} */
function isTruncated(ev, inner) {
  return ev.truncated === true || inner.truncated === true;
}

/** @param {TranscriptState} state @param {string} reqId @param {object} ev @returns {TranscriptState} */
function onStepUpdate(state, reqId, ev) {
  const step = ev.step_update && typeof ev.step_update === 'object' ? ev.step_update : {};
  if (step.step_type === 'user_input') return state; // echo of our own prompt; the user row already shows it
  if (step.step_type === 'agent_response') {
    return onAgentText(state, reqId, step.text_delta, isTruncated(ev, step));
  }
  return upsertStep(state, reqId, step);
}

/**
 * Append text to the latest assistant message of this run. Text from every agent_response step of the
 * run (any step_index) goes into the same message; tool rows in between do not split it.
 * @param {TranscriptState} state @param {string} reqId @param {unknown} delta @param {boolean} truncated
 * @returns {TranscriptState}
 */
function onAgentText(state, reqId, delta, truncated) {
  const text = str(delta);
  if (!text) return state;
  const index = findLastIndex(state.rows, (r) => r.kind === 'assistant' && r.reqId === reqId);
  if (index === -1) return appendRow(state, { kind: 'assistant', reqId, text, truncated });
  const prev = state.rows[index];
  return patchRow(state, index, { text: prev.text + text, truncated: prev.truncated || truncated });
}

/**
 * Tool and other step rows are keyed by reqId + step_index, so ACTIVE -> DONE updates the same row.
 * @param {TranscriptState} state @param {string} reqId @param {object} step
 * @returns {TranscriptState}
 */
function upsertStep(state, reqId, step) {
  const stepIndex = num(step.step_index);
  const index = state.rows.findIndex((r) => r.kind === 'step' && r.reqId === reqId && r.stepIndex === stepIndex);
  const prev = index === -1 ? null : state.rows[index];
  const row = {
    kind: 'step',
    reqId,
    stepIndex,
    stepType: str(step.step_type),
    toolName: str(step.tool_name),
    toolInfo: toolInfoText(step.tool_info) || prev?.toolInfo || '',
    state: str(step.state),
    durationSeconds: num(step.duration_seconds) ?? prev?.durationSeconds ?? null,
  };
  if (index === -1) return appendRow(state, row);
  return patchRow(state, index, row);
}

/** @param {TranscriptState} state @param {string} reqId @param {object} ev @returns {TranscriptState} */
function onResult(state, reqId, ev) {
  const r = ev.result && typeof ev.result === 'object' ? ev.result : {};
  const error = str(r.error) || null;
  const withConversation = { ...state, conversationId: str(r.conversation_id) || state.conversationId };
  const patched = patchRun(withConversation, reqId, {
    resultStatus: str(r.status) || null,
    usage: r.usage && typeof r.usage === 'object' ? r.usage : null,
    error,
    durationSeconds: num(r.duration_seconds),
    numTurns: num(r.num_turns),
  });
  const withResponse = ensureResponseText(patched, reqId, r, isTruncated(ev, r));
  return error ? note(withResponse, reqId, `agent error: ${error}`) : withResponse;
}

/**
 * Fallback for agents that never streamed text: use result.response when this run has no assistant text.
 * @param {TranscriptState} state @param {string} reqId @param {object} result @param {boolean} truncated
 * @returns {TranscriptState}
 */
function ensureResponseText(state, reqId, result, truncated) {
  const response = str(result.response);
  const hasText = state.rows.some((r) => r.kind === 'assistant' && r.reqId === reqId && r.text);
  if (!response || hasText) return state;
  return appendRow(state, { kind: 'assistant', reqId, text: response, truncated });
}

/** @param {string} prev @param {string} add @returns {string} keeps the newest MAX_STDERR_CHARS */
function appendCapped(prev, add) {
  const joined = prev + add;
  return joined.length > MAX_STDERR_CHARS ? joined.slice(-MAX_STDERR_CHARS) : joined;
}

/** @param {TranscriptState} state @param {string} reqId @param {unknown} text @returns {TranscriptState} */
function onStderr(state, reqId, text) {
  const prev = state.runs[reqId].stderr;
  return patchRun(state, reqId, { stderr: appendCapped(prev, str(text)) });
}

/** @param {TranscriptState} state @param {string} reqId @param {object} msg @returns {TranscriptState} */
function onExit(state, reqId, msg) {
  const run = state.runs[reqId];
  const cancelled = msg.cancelled === true;
  const failed = run.phase === 'error' || run.resultStatus === 'ERROR' || msg.code !== 0;
  let phase = 'done';
  if (cancelled) phase = 'cancelled';
  else if (failed) phase = 'error';
  return patchRun(state, reqId, {
    phase, cancelled, exitCode: num(msg.code), signal: str(msg.signal) || null,
  });
}

/** @param {TranscriptState} state @param {object} msg @returns {TranscriptState} */
function onError(state, msg) {
  const code = str(msg.code) || 'ERROR';
  const message = str(msg.message) || code;
  const reqId = typeof msg.reqId === 'string' ? msg.reqId : null;
  const withLast = { ...state, lastError: { code, message } };
  // DUPLICATE_REQ names an existing run's reqId but does not belong to it, so that run is left alone.
  const affectsRun = hasRun(withLast, reqId) && code !== ERR.DUPLICATE_REQ;
  const updated = affectsRun ? patchRun(withLast, reqId, { phase: 'error', error: message }) : withLast;
  return note(updated, reqId, `${code}: ${message}`);
}
