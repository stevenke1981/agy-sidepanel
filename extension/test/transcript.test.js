import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_STDERR_CHARS, MAX_TOOL_INFO_CHARS, abandonRunningRuns, addUserMessage, applyHostMessage, hasActiveRun,
  initialState, newConversation, startRun,
} from '../src/lib/transcript.js';
import { ERR, RES } from '../src/lib/protocol.js';

const RUN_A = 'rAAAA';
const RUN_B = 'rBBBB';
const CONV = '11111111-2222-3333-4444-555555555555';

/** @param {object} state @param {object[]} msgs @returns {object} */
function applyAll(state, msgs) {
  return msgs.reduce((s, m) => applyHostMessage(s, m), state);
}

/** @param {string} reqId @param {object} event @returns {object} */
function ev(reqId, event) {
  return { type: RES.EVENT, reqId, event };
}

/** @param {string} reqId @param {object} stepUpdate @returns {object} */
function step(reqId, stepUpdate) {
  return ev(reqId, { event: 'step_update', step_update: stepUpdate });
}

/** @param {string} reqId @returns {object} */
function exit(reqId, extra = {}) {
  return { type: RES.EXIT, reqId, code: 0, signal: null, cancelled: false, ...extra };
}

/** @param {object} state @param {string} reqId @returns {object[]} */
function rowsFor(state, reqId) {
  return state.rows.filter((r) => r.reqId === reqId);
}

test('init event stores conversation id, model, permission mode and tool count', () => {
  const state = applyHostMessage(startRun(initialState(), RUN_A), ev(RUN_A, {
    event: 'init', conversation_id: CONV,
    init: { model: 'gemini-x', cwd: 'D:\\p', tools: ['a', 'b', 'c'], permission_mode: 'plan' },
  }));
  assert.equal(state.conversationId, CONV);
  assert.deepEqual(state.init, { model: 'gemini-x', permissionMode: 'plan', toolCount: 3, cwd: 'D:\\p' });
});

test('agent_response text deltas from several steps append to one assistant message per run', () => {
  let state = startRun(addUserMessage(initialState(), 'hi'), RUN_A);
  state = applyAll(state, [
    step(RUN_A, { step_index: 1, step_type: 'agent_response', text_delta: 'Hel' }),
    step(RUN_A, { step_index: 1, step_type: 'agent_response', text_delta: 'lo ' }),
    step(RUN_A, { step_index: 3, step_type: 'agent_response', text_delta: 'world' }),
  ]);
  const assistant = rowsFor(state, RUN_A).filter((r) => r.kind === 'assistant');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].text, 'Hello world');
});

test('tool step updates the same row from ACTIVE to DONE with toolName, toolInfo and duration', () => {
  let state = startRun(addUserMessage(initialState(), 'run tool'), RUN_A);
  state = applyHostMessage(state, step(RUN_A, {
    step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'read_file', tool_info: { path: 'a.txt' },
  }));
  state = applyHostMessage(state, step(RUN_A, {
    step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'read_file', tool_info: { path: 'a.txt' },
    duration_seconds: 0.42,
  }));
  const steps = rowsFor(state, RUN_A).filter((r) => r.kind === 'step');
  assert.equal(steps.length, 1, 'ACTIVE and DONE must share one row');
  assert.deepEqual(
    { ...steps[0], id: undefined },
    {
      kind: 'step', reqId: RUN_A, stepIndex: 2, stepType: 'tool', toolName: 'read_file',
      toolInfo: '{"path":"a.txt"}', state: 'DONE', durationSeconds: 0.42, id: undefined,
    },
  );
});

test('tool info is capped and string tool info is kept as given', () => {
  const big = { data: 'z'.repeat(1000) };
  const state = applyHostMessage(startRun(initialState(), RUN_A), step(RUN_A, {
    step_index: 1, step_type: 'tool', state: 'ACTIVE', tool_name: 'x', tool_info: big,
  }));
  const row = state.rows.find((r) => r.kind === 'step');
  assert.equal(row.toolInfo.length, MAX_TOOL_INFO_CHARS + 3);
  assert.ok(row.toolInfo.endsWith('...'));
  const plain = applyHostMessage(startRun(initialState(), RUN_A), step(RUN_A, {
    step_index: 1, step_type: 'tool', state: 'ACTIVE', tool_name: 'y', tool_info: 'short',
  }));
  assert.equal(plain.rows.find((r) => r.kind === 'step').toolInfo, 'short');
});

test('user_input step echoes are not added as rows', () => {
  const before = startRun(initialState(), RUN_A);
  const after = applyHostMessage(before, step(RUN_A, { step_index: 0, step_type: 'user_input', state: 'DONE' }));
  assert.equal(after, before);
});

test('result event records status, usage and error; error status yields an error note', () => {
  const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
  const state = applyAll(startRun(initialState(), RUN_A), [
    ev(RUN_A, { event: 'result', result: { status: 'ERROR', error: 'quota', usage, duration_seconds: 2, num_turns: 1 } }),
  ]);
  const run = state.runs[RUN_A];
  assert.equal(run.resultStatus, 'ERROR');
  assert.deepEqual(run.usage, usage);
  assert.equal(run.error, 'quota');
  assert.equal(run.durationSeconds, 2);
  assert.ok(state.rows.some((r) => r.kind === 'note' && r.text === 'agent error: quota'));
});

test('result response is used only when the run streamed no assistant text', () => {
  const streamed = applyAll(startRun(initialState(), RUN_A), [
    step(RUN_A, { step_index: 1, step_type: 'agent_response', text_delta: 'partial' }),
    ev(RUN_A, { event: 'result', result: { status: 'SUCCESS', response: 'full answer' } }),
  ]);
  assert.equal(rowsFor(streamed, RUN_A).find((r) => r.kind === 'assistant').text, 'partial');

  const silent = applyHostMessage(startRun(initialState(), RUN_B), ev(RUN_B, {
    event: 'result', result: { status: 'SUCCESS', response: 'only result' },
  }));
  assert.equal(rowsFor(silent, RUN_B).find((r) => r.kind === 'assistant').text, 'only result');
});

test('unknown events become a generic note row and oversize events are reported with their size', () => {
  const state = applyAll(startRun(initialState(), RUN_A), [
    ev(RUN_A, { event: 'mystery', foo: 1 }),
    ev(RUN_A, { event: 'oversize', originalEvent: 'step_update', bytes: 2_000_000 }),
  ]);
  const notes = rowsFor(state, RUN_A).filter((r) => r.kind === 'note').map((r) => r.text);
  assert.equal(notes.length, 2);
  assert.ok(notes[0].startsWith('event mystery:'));
  assert.equal(notes[1], 'output too large: step_update (2000000 bytes), skipped');
});

test('stderr is collected per run and capped to the newest characters', () => {
  const chunk = 'e'.repeat(3000);
  const state = applyAll(startRun(initialState(), RUN_A), [
    { type: RES.STDERR, reqId: RUN_A, text: chunk },
    { type: RES.STDERR, reqId: RUN_A, text: `${'f'.repeat(3000)}END` },
  ]);
  assert.equal(state.runs[RUN_A].stderr.length, MAX_STDERR_CHARS);
  assert.ok(state.runs[RUN_A].stderr.endsWith('END'));
});

test('EXIT marks a clean run done and a cancelled run cancelled', () => {
  const done = applyHostMessage(startRun(initialState(), RUN_A), exit(RUN_A));
  assert.equal(done.runs[RUN_A].phase, 'done');
  const cancelled = applyHostMessage(startRun(initialState(), RUN_B), exit(RUN_B, { cancelled: true, code: null }));
  assert.equal(cancelled.runs[RUN_B].phase, 'cancelled');
  assert.equal(cancelled.runs[RUN_B].cancelled, true);
});

test('EXIT after a result with status ERROR or a non-zero code is an error', () => {
  const resultError = applyAll(startRun(initialState(), RUN_A), [
    ev(RUN_A, { event: 'result', result: { status: 'ERROR' } }), exit(RUN_A),
  ]);
  assert.equal(resultError.runs[RUN_A].phase, 'error');
  const crashed = applyHostMessage(startRun(initialState(), RUN_B), exit(RUN_B, { code: 3 }));
  assert.equal(crashed.runs[RUN_B].phase, 'error');
  assert.equal(crashed.runs[RUN_B].exitCode, 3);
});

test('ERROR with a reqId marks that run as error and keeps it errored after EXIT', () => {
  const state = applyAll(startRun(initialState(), RUN_A), [
    { type: RES.ERROR, reqId: RUN_A, code: ERR.SPAWN_FAILED, message: 'no agy' },
    exit(RUN_A, { code: null }),
  ]);
  assert.equal(state.runs[RUN_A].phase, 'error');
  assert.equal(state.runs[RUN_A].error, 'no agy');
  assert.deepEqual(state.lastError, { code: ERR.SPAWN_FAILED, message: 'no agy' });
});

test('DUPLICATE_REQ does not change the run it names', () => {
  const state = applyHostMessage(startRun(initialState(), RUN_A), {
    type: RES.ERROR, reqId: RUN_A, code: ERR.DUPLICATE_REQ, message: 'dup',
  });
  assert.equal(state.runs[RUN_A].phase, 'running');
  assert.ok(state.rows.some((r) => r.kind === 'note' && r.text === 'DUPLICATE_REQ: dup'));
});

test('ERROR without a reqId is a global note and sets lastError', () => {
  const state = applyHostMessage(initialState(), { type: RES.ERROR, reqId: null, code: ERR.PROTOCOL_MISMATCH, message: 'v2' });
  assert.deepEqual(state.lastError, { code: ERR.PROTOCOL_MISMATCH, message: 'v2' });
  assert.equal(state.rows[0].reqId, null);
});

test('concurrent runs keep their messages separate', () => {
  let state = initialState();
  state = addUserMessage(state, 'first');
  state = startRun(state, RUN_A);
  state = addUserMessage(state, 'second');
  state = startRun(state, RUN_B);
  state = applyAll(state, [
    step(RUN_A, { step_index: 1, step_type: 'agent_response', text_delta: 'A1' }),
    step(RUN_B, { step_index: 1, step_type: 'agent_response', text_delta: 'B1' }),
    step(RUN_A, { step_index: 1, step_type: 'agent_response', text_delta: 'A2' }),
    exit(RUN_B),
  ]);
  assert.equal(rowsFor(state, RUN_A).find((r) => r.kind === 'assistant').text, 'A1A2');
  assert.equal(rowsFor(state, RUN_B).find((r) => r.kind === 'assistant').text, 'B1');
  assert.equal(state.runs[RUN_A].phase, 'running');
  assert.equal(state.runs[RUN_B].phase, 'done');
  assert.equal(hasActiveRun(state), true);
});

test('startRun binds each user message to its own run', () => {
  let state = addUserMessage(initialState(), 'one');
  state = startRun(state, RUN_A);
  state = addUserMessage(state, 'two');
  state = startRun(state, RUN_B);
  const users = state.rows.filter((r) => r.kind === 'user');
  assert.deepEqual(users.map((u) => u.reqId), [RUN_A, RUN_B]);
});

test('messages for unknown reqIds are ignored (for example after newConversation)', () => {
  const before = newConversation();
  const after = applyAll(before, [
    ev('rGONE', { event: 'init', conversation_id: CONV, init: {} }),
    step('rGONE', { step_index: 1, step_type: 'agent_response', text_delta: 'late' }),
    exit('rGONE'),
  ]);
  assert.equal(after, before);
});

test('hello, models and cancelled acks leave the transcript unchanged', () => {
  const state = startRun(initialState(), RUN_A);
  const after = applyAll(state, [
    { type: RES.HELLO, protocol: 1 }, { type: RES.MODELS, reqId: RUN_A, models: [] },
    { type: RES.CANCELLED, reqId: RUN_A },
  ]);
  assert.equal(after, state);
});

test('reducer is immutable: the previous state is not mutated', () => {
  const state = startRun(addUserMessage(initialState(), 'hi'), RUN_A);
  const snapshot = structuredClone(state);
  applyAll(state, [
    step(RUN_A, { step_index: 1, step_type: 'agent_response', text_delta: 'x' }),
    step(RUN_A, { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 't' }),
    { type: RES.STDERR, reqId: RUN_A, text: 'err' },
    exit(RUN_A),
  ]);
  assert.deepEqual(state, snapshot);
});

test('addUserMessage stores context metadata only and assigns increasing ids', () => {
  const state = addUserMessage(initialState(), 'q', { title: 'T', url: 'U', chars: 12 });
  assert.deepEqual(state.rows[0].context, { title: 'T', url: 'U', chars: 12 });
  const next = addUserMessage(state, 'again');
  assert.equal(next.rows[1].context, null);
  assert.ok(next.rows[1].id > next.rows[0].id);
});

test('newConversation returns a fresh state and startRun ignores a duplicate reqId', () => {
  const started = startRun(initialState(), RUN_A);
  assert.equal(startRun(started, RUN_A), started);
  assert.deepEqual(newConversation(), initialState());
});

test('non-object messages are ignored', () => {
  const state = initialState();
  assert.equal(applyHostMessage(state, null), state);
  assert.equal(applyHostMessage(state, 'text'), state);
});

test('abandonRunningRuns marks only running runs as failed and clears hasActiveRun', () => {
  let s = initialState();
  s = startRun(s, RUN_A);
  s = startRun(s, RUN_B);
  s = applyHostMessage(s, { type: RES.EXIT, reqId: RUN_B, code: 0, signal: null, cancelled: false });
  const before = s;
  const after = abandonRunningRuns(s, 'Host disconnected: gone');
  assert.equal(after.runs[RUN_A].phase, 'error');
  assert.equal(after.runs[RUN_A].error, 'Host disconnected: gone');
  assert.equal(after.runs[RUN_B].phase, 'done');
  assert.equal(hasActiveRun(after), false);
  assert.equal(before.runs[RUN_A].phase, 'running', 'input state must not be mutated');
  assert.equal(abandonRunningRuns(after, 'x'), after, 'no running runs returns the same state');
});
