import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addUserMessage, appendNote, applyHostMessage, hasActiveRun, initialState, startRun
} from '../src/lib/transcript.js';
import { RES } from '../src/lib/protocol.js';
import { toViewModel } from '../src/ui/view-model.js';

const RUN = 'rAAAA';
const CONV = '11111111-2222-3333-4444-555555555555';
const USAGE = Object.freeze({ input_tokens: 120, output_tokens: 45, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 165 });

/** Wrap a parsed agy stream-json line the way the host delivers it. */
const ev = (reqId, event) => ({ type: RES.EVENT, reqId, event });
const stepUpdate = (reqId, step) => ev(reqId, { event: 'step_update', conversation_id: CONV, step_update: step });
const exit = (reqId, extra = {}) => ({ type: RES.EXIT, reqId, code: 0, signal: null, cancelled: false, ...extra });

const applyAll = (state, messages) => messages.reduce((s, m) => applyHostMessage(s, m), state);

/** A finished run driven entirely through the real reducer. */
function finishedRunState() {
  let s = addUserMessage(initialState(), 'Summarize the page', { title: 'Guide', url: 'https://docs.test/a', chars: 1200 });
  s = startRun(s, RUN);
  return applyAll(s, [
    ev(RUN, { event: 'init', conversation_id: CONV, init: { model: 'gemini-x', cwd: '/w', tools: ['view_file', 'grep'], permission_mode: 'plan' } }),
    stepUpdate(RUN, { step_index: 0, step_type: 'user_input', state: 'DONE', text_delta: 'Summarize the page' }),
    stepUpdate(RUN, { step_index: 1, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Let me check. ' }),
    stepUpdate(RUN, { step_index: 2, step_type: 'tool', tool_name: 'view_file', tool_info: { path: 'src/a.js' }, state: 'ACTIVE' }),
    stepUpdate(RUN, { step_index: 2, step_type: 'tool', tool_name: 'view_file', state: 'DONE', duration_seconds: 0.42 }),
    stepUpdate(RUN, { step_index: 3, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'The file ' }),
    stepUpdate(RUN, { step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: 'is fine.' }),
    ev(RUN, {
      event: 'result',
      result: { conversation_id: CONV, status: 'SUCCESS', response: 'The file is fine.', duration_seconds: 2.1, num_turns: 1, usage: USAGE }
    }),
    exit(RUN)
  ]);
}

test('a finished run from real reducer output maps to the exact view shape', () => {
  const view = toViewModel(finishedRunState());
  assert.deepEqual(view.messages, [
    { id: 1, role: 'user', text: 'Summarize the page', reqId: RUN, contextSummary: { title: 'Guide', url: 'https://docs.test/a', chars: 1200 } },
    { id: 2, role: 'assistant', text: 'Let me check. The file is fine.', reqId: RUN },
    {
      id: 3, role: 'step', reqId: RUN, text: '{"path":"src/a.js"}', toolInfo: '{"path":"src/a.js"}',
      stepType: 'tool', toolName: 'view_file', state: 'DONE', durationSeconds: 0.42
    }
  ]);
  assert.equal(view.conversationId, CONV);
  assert.equal(view.model, 'gemini-x');
  assert.equal(view.permissionMode, 'plan');
  assert.equal(view.toolsCount, 2);
  assert.equal(view.status, 'SUCCESS');
  assert.deepEqual(view.usage, USAGE);
  assert.equal(view.error, null);
  assert.equal(view.running, false);
  assert.equal(view.activeReqId, null);
});

test('a run in flight reports running and its reqId; status and usage wait for the result', () => {
  let s = addUserMessage(initialState(), 'hi');
  s = startRun(s, RUN);
  s = applyAll(s, [ev(RUN, { event: 'init', conversation_id: CONV, init: { model: 'm', tools: [] } })]);
  const view = toViewModel(s);
  assert.equal(view.running, true);
  assert.equal(view.activeReqId, RUN);
  assert.equal(view.status, null);
  assert.equal(view.usage, null);
  assert.equal('contextSummary' in view.messages[0], false, 'no page context means no contextSummary key');
  assert.equal(hasActiveRun(s), true);
});

test('a failed run maps to status ERROR with the run error and a note row', () => {
  let s = startRun(addUserMessage(initialState(), 'go'), RUN);
  s = applyAll(s, [
    ev(RUN, { event: 'result', result: { conversation_id: CONV, status: 'ERROR', error: 'quota exceeded', usage: null } }),
    exit(RUN, { code: 1 })
  ]);
  const view = toViewModel(s);
  assert.equal(view.status, 'ERROR');
  assert.equal(view.error, 'quota exceeded');
  assert.equal(view.usage, null);
  assert.equal(view.running, false);
  assert.deepEqual(view.messages.at(-1), { id: 2, role: 'note', text: 'agent error: quota exceeded', reqId: RUN });
});

test('the most recent run is the one started last, even when its reqId is integer-like', () => {
  // Object.keys() orders integer-like keys first, so '20' would appear before '100' there.
  const FIRST = '100';
  const SECOND = '20';
  const FIRST_USAGE = { ...USAGE, total_tokens: 1 };
  const SECOND_USAGE = { ...USAGE, total_tokens: 2 };
  let s = startRun(addUserMessage(initialState(), 'one'), FIRST);
  s = applyAll(s, [
    ev(FIRST, { event: 'result', result: { status: 'SUCCESS', usage: FIRST_USAGE } }),
    exit(FIRST)
  ]);
  s = startRun(addUserMessage(s, 'two'), SECOND);
  let view = toViewModel(s);
  assert.equal(view.activeReqId, SECOND);
  assert.equal(view.usage, null, 'the second run has no result yet, so the first run usage must not leak in');
  s = applyAll(s, [ev(SECOND, { event: 'result', result: { status: 'SUCCESS', usage: SECOND_USAGE } }), exit(SECOND)]);
  view = toViewModel(s);
  assert.deepEqual(view.usage, SECOND_USAGE);
  assert.equal(view.activeReqId, null);
});

test('UI-originated notes keep their reducer row kind: error rows map to role error, notes to note', () => {
  const s = appendNote(appendNote(initialState(), 'Host disconnected: gone', 'error'), 'Page notice');
  const view = toViewModel(s);
  assert.deepEqual(view.messages.map((m) => [m.role, m.text, m.reqId]), [
    ['error', 'Host disconnected: gone', null],
    ['note', 'Page notice', null]
  ]);
});

test('an empty, null or malformed state yields the empty view', () => {
  const empty = {
    conversationId: null, messages: [], status: null, usage: null, error: null,
    model: '', permissionMode: '', toolsCount: 0, running: false, activeReqId: null
  };
  assert.deepEqual(toViewModel(initialState()), empty);
  assert.deepEqual(toViewModel(null), empty);
  assert.deepEqual(toViewModel({ rows: null, runs: null }), empty);
});

test('an unchanged reducer row yields the same view object, so DOM nodes can be reused', () => {
  const before = finishedRunState();
  const first = toViewModel(before);
  const after = appendNote(before, 'a later notice');
  const second = toViewModel(after);
  assert.equal(second.messages[0], first.messages[0]);
  assert.equal(second.messages[1], first.messages[1]);
  assert.equal(second.messages.length, first.messages.length + 1);
});

test('toViewModel never mutates the reducer state', () => {
  const state = finishedRunState();
  const snapshot = JSON.stringify(state);
  toViewModel(state);
  assert.equal(JSON.stringify(state), snapshot);
});
