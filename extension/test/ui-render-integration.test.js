import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addUserMessage, applyHostMessage, initialState, startRun } from '../src/lib/transcript.js';
import { RES } from '../src/lib/protocol.js';
import { toViewModel } from '../src/ui/view-model.js';
import { createTranscriptRenderer } from '../src/ui/transcript.js';
import { renderSessionBadge, renderUsage } from '../src/ui/panel-render.js';
import { createFakeDocument, withClass } from './ui-fake-dom.js';

const RUN = 'rCCCC';
const CONV = '99999999-8888-7777-6666-555555555555';
const USAGE = Object.freeze({ input_tokens: 120, output_tokens: 45, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 165 });

const ev = (reqId, event) => ({ type: RES.EVENT, reqId, event });
const stepUpdate = (reqId, step) => ev(reqId, { event: 'step_update', conversation_id: CONV, step_update: step });

/** The same real reducer sequence the view-model test uses, here driven into the renderer. */
function realState() {
  let s = addUserMessage(initialState(), 'Summarize the page', { title: 'Guide', url: 'https://docs.test/a', chars: 1200 });
  s = startRun(s, RUN);
  const messages = [
    ev(RUN, { event: 'init', conversation_id: CONV, init: { model: 'gemini-x', cwd: '/w', tools: ['view_file', 'grep'], permission_mode: 'plan' } }),
    stepUpdate(RUN, { step_index: 1, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Let me check. ' }),
    stepUpdate(RUN, { step_index: 2, step_type: 'tool', tool_name: 'view_file', tool_info: { path: 'src/a.js' }, state: 'ACTIVE' }),
    stepUpdate(RUN, { step_index: 2, step_type: 'tool', tool_name: 'view_file', state: 'DONE', duration_seconds: 0.42 }),
    stepUpdate(RUN, { step_index: 3, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'The file is fine.' }),
    ev(RUN, { event: 'result', result: { conversation_id: CONV, status: 'SUCCESS', response: 'The file is fine.', usage: USAGE } }),
    { type: RES.EXIT, reqId: RUN, code: 0, signal: null, cancelled: false }
  ];
  return messages.reduce((acc, m) => applyHostMessage(acc, m), s);
}

function fakePanelElements(doc) {
  return { 'session-badge': doc.createElement('span'), usage: doc.createElement('div') };
}

test('the real reducer state renders through the transcript renderer without throwing', () => {
  const doc = createFakeDocument();
  const container = doc.createElement('main');
  const renderer = createTranscriptRenderer(doc);
  assert.doesNotThrow(() => renderer.render(container, toViewModel(realState()).messages, { busy: false }));

  assert.equal(withClass(container, 'bubble')[0].textContent, 'Summarize the page');
  assert.equal(withClass(container, 'chip-title')[0].textContent, 'Guide');
  assert.equal(withClass(container, 'step-name')[0].textContent, 'view_file');
  assert.equal(withClass(container, 'step-dur')[0].textContent, '0.4s');
  const assistant = withClass(container, 'md')[0].textContent;
  assert.ok(assistant.includes('Let me check. The file is fine.'), `assistant text was: ${assistant}`);
});

test('the rendered step row shows toolInfo once, not duplicated as output', () => {
  const doc = createFakeDocument();
  const container = doc.createElement('main');
  createTranscriptRenderer(doc).render(container, toViewModel(realState()).messages, { busy: false });
  const info = withClass(container, 'step-info');
  assert.equal(info.length, 1);
  assert.equal(info[0].textContent, '{"path":"src/a.js"}');
  assert.equal(withClass(container, 'step-out').length, 0);
});

test('session badge and usage line render from the view model of the same real state', () => {
  const doc = createFakeDocument();
  const el = fakePanelElements(doc);
  const view = toViewModel(realState());
  assert.doesNotThrow(() => {
    renderSessionBadge(el, view);
    renderUsage(el, view);
  });
  assert.equal(el['session-badge'].textContent, 'gemini-x · plan · 2 tools');
  assert.equal(el['session-badge'].hidden, false);
  assert.equal(el.usage.textContent, 'in 120 · out 45 · total 165');
  assert.equal(el.usage.getAttribute('data-status'), 'ok');
});

test('re-rendering while busy keeps the same state renderable', () => {
  const doc = createFakeDocument();
  const container = doc.createElement('main');
  const renderer = createTranscriptRenderer(doc);
  const view = toViewModel(realState());
  renderer.render(container, view.messages, { busy: true });
  assert.doesNotThrow(() => renderer.render(container, toViewModel(realState()).messages, { busy: false }));
  assert.equal(withClass(container, 'step-name')[0].textContent, 'view_file');
});
