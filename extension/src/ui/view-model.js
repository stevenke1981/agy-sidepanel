// Pure mapping from the transcript reducer state (lib/transcript.js) to the side panel view shape.
// The renderers read only this shape, so the reducer can change its internals without touching the UI.
// Message objects are memoized per reducer row: an unchanged row yields the same view object, which keeps
// the transcript renderer's per-message DOM cache (and open <details> rows) valid across re-renders.
import { hasActiveRun } from '../lib/transcript.js';

/**
 * @typedef {{id: number, role: string, text: string, reqId: string|null,
 *   contextSummary?: {title: string, url: string, chars: number},
 *   stepType?: string, toolName?: string, toolInfo?: string, state?: string, durationSeconds?: number|null}} ViewMessage
 * @typedef {{conversationId: string|null, messages: ViewMessage[], status: string|null, usage: object|null,
 *   error: string|null, model: string, permissionMode: string, toolsCount: number, running: boolean,
 *   activeReqId: string|null}} ViewModel
 */

const rowMessages = new WeakMap();

/** @param {unknown} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v : '';
}

/** @param {object} row a reducer row @returns {ViewMessage} */
function buildMessage(row) {
  const base = { id: row.id, text: str(row.text), reqId: row.reqId ?? null };
  if (row.kind === 'user') {
    const message = { ...base, role: 'user' };
    if (row.context) {
      message.contextSummary = { title: str(row.context.title), url: str(row.context.url), chars: row.context.chars ?? 0 };
    }
    return message;
  }
  if (row.kind === 'assistant') return { ...base, role: 'assistant' };
  if (row.kind === 'step') {
    const toolInfo = str(row.toolInfo);
    return {
      ...base,
      role: 'step',
      text: toolInfo,
      toolInfo,
      stepType: str(row.stepType),
      toolName: str(row.toolName),
      state: str(row.state),
      durationSeconds: row.durationSeconds ?? null
    };
  }
  return { ...base, role: row.kind === 'error' ? 'error' : 'note' };
}

/** @param {object} row @returns {ViewMessage} */
function toMessage(row) {
  const cached = rowMessages.get(row);
  if (cached) return cached;
  const message = buildMessage(row);
  rowMessages.set(row, message);
  return message;
}

/**
 * Runs ordered by start. The reducer appends a run's user row at startRun, so a run's first row position is
 * its start order. This is robust to integer-like reqIds, which Object.keys would reorder.
 * @param {{rows: object[], runs: Record<string, object>}} input
 * @returns {Array<{reqId: string, run: object}>} oldest first
 */
function orderedRuns({ rows, runs }) {
  const firstRow = new Map();
  rows.forEach((row, index) => {
    if (typeof row.reqId === 'string' && !firstRow.has(row.reqId)) firstRow.set(row.reqId, index);
  });
  return Object.keys(runs)
    .map((reqId, keyIndex) => ({ reqId, run: runs[reqId], start: firstRow.get(reqId) ?? -1, keyIndex }))
    .sort((a, b) => a.start - b.start || a.keyIndex - b.keyIndex);
}

/** @param {object} run @returns {string|null} */
function statusOf(run) {
  if (run.phase === 'error' || run.resultStatus === 'ERROR') return 'ERROR';
  return run.resultStatus ?? null;
}

/**
 * @param {object|null|undefined} reducerState a TranscriptState (or null)
 * @returns {ViewModel}
 */
export function toViewModel(reducerState) {
  const state = {
    conversationId: null, init: null, rows: [], runs: {}, ...(reducerState ?? {})
  };
  const rows = (Array.isArray(state.rows) ? state.rows : []).filter((row) => row && typeof row === 'object');
  const runsMap = state.runs && typeof state.runs === 'object' ? state.runs : {};
  const ordered = orderedRuns({ rows, runs: runsMap });
  const latest = ordered.at(-1)?.run ?? null;
  const activeRun = [...ordered].reverse().find((entry) => entry.run.phase === 'running') ?? null;
  const init = state.init && typeof state.init === 'object' ? state.init : {};
  return {
    conversationId: state.conversationId ?? null,
    messages: rows.map(toMessage),
    status: latest ? statusOf(latest) : null,
    usage: latest?.usage ?? null,
    error: latest?.error ?? null,
    model: str(init.model),
    permissionMode: str(init.permissionMode),
    toolsCount: typeof init.toolCount === 'number' ? init.toolCount : 0,
    running: hasActiveRun({ runs: runsMap }),
    activeReqId: activeRun?.reqId ?? null
  };
}
