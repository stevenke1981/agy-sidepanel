import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptRenderer } from '../src/ui/transcript.js';
import { stepStateOf, stepTitle } from '../src/ui/step-row.js';
import { createFakeDocument, elementsOf, findTag, withClass } from './ui-fake-dom.js';

function renderInto(messages, busy = false) {
  const doc = createFakeDocument();
  const container = doc.createElement('main');
  const renderer = createTranscriptRenderer(doc);
  renderer.render(container, messages, { busy });
  return { doc, container, renderer };
}

const ACTIVE_STEP = Object.freeze({
  id: 's1', role: 'step', stepType: 'tool', toolName: 'read_file', toolInfo: 'path=src/a.js', state: 'ACTIVE', text: ''
});

test('an empty transcript shows the onboarding empty state', () => {
  const { container } = renderInto([]);
  assert.equal(withClass(container, 'empty-title')[0].textContent, 'Ask agy anything.');
});

test('an ACTIVE step shows the tool name, a spinner, the running label and toolInfo in the detail', () => {
  const { container } = renderInto([ACTIVE_STEP]);
  const row = withClass(container, 'step')[0];
  assert.equal(row.getAttribute('data-state'), 'active');
  assert.equal(withClass(row, 'step-name')[0].textContent, 'read_file');
  assert.equal(withClass(row, 'step-spinner').length, 1);
  assert.equal(withClass(row, 'step-state-text')[0].textContent, 'running');
  assert.equal(withClass(row, 'step-info')[0].textContent, 'path=src/a.js');
});

test('a DONE step with the same id shows a check, the duration, and no spinner', () => {
  const done = { ...ACTIVE_STEP, state: 'DONE', text: 'contents', durationSeconds: 1.23 };
  const { container } = renderInto([done]);
  const row = withClass(container, 'step')[0];
  assert.equal(row.getAttribute('data-state'), 'done');
  assert.equal(withClass(row, 'step-check').length, 1);
  assert.equal(withClass(row, 'step-spinner').length, 0);
  assert.equal(withClass(row, 'step-dur')[0].textContent, '1.2s');
  assert.equal(withClass(row, 'step-out').length, 0);
});

test('step titles fall back from toolName to stepType to a generic label', () => {
  assert.equal(stepTitle({ toolName: 'grep', stepType: 'tool' }), 'grep');
  assert.equal(stepTitle({ stepType: 'tool' }), 'tool');
  assert.equal(stepTitle({}), 'step');
  assert.equal(stepStateOf({ state: 'active' }), 'active');
  assert.equal(stepStateOf({ state: 'DONE' }), 'done');
});

test('a step with no toolInfo or output shows a neutral empty detail', () => {
  const bare = { id: 's2', role: 'step', state: 'DONE' };
  const { container } = renderInto([bare]);
  assert.equal(withClass(container, 'step-empty')[0].textContent, 'No details.');
});

test('user bubbles show text as plain text and a context chip when page context was sent', () => {
  const user = {
    id: 'u1',
    role: 'user',
    text: '<b>hi</b>',
    contextSummary: { title: 'Guide', url: 'https://docs.test/a', chars: 1500 }
  };
  const { container } = renderInto([user]);
  assert.equal(withClass(container, 'bubble')[0].textContent, '<b>hi</b>');
  assert.equal(withClass(container, 'chip-title')[0].textContent, 'Guide');
  assert.equal(withClass(container, 'chip-host')[0].textContent, 'docs.test');
  assert.equal(withClass(container, 'chip-chars')[0].textContent, '1,500 chars');
});

test('assistant text renders through the safe markdown subset', () => {
  const assistant = { id: 'a1', role: 'assistant', text: 'Use `x`.\n\n```\ny\n```' };
  const { container } = renderInto([assistant]);
  const md = withClass(container, 'md')[0];
  assert.ok(findTag(md, 'PRE'));
  assert.equal(elementsOf(md).find((e) => e.tagName === 'CODE' && e.textContent === 'x').textContent, 'x');
});

test('errors use an alert role; unknown roles fall back to a visible note', () => {
  const { container } = renderInto([
    { id: 'e1', role: 'error', text: 'boom' },
    { id: 'n1', role: 'mystery_event', text: 'raw event' }
  ]);
  const [errorNote, unknown] = withClass(container, 'note');
  assert.equal(errorNote.getAttribute('role'), 'alert');
  assert.equal(errorNote.textContent, 'boom');
  assert.equal(unknown.textContent, 'raw event');
});

test('busy adds a working indicator after the messages', () => {
  const { container } = renderInto([{ id: 'u', role: 'user', text: 'q' }], true);
  const last = container.childNodes.at(-1);
  assert.equal(last.getAttribute('role'), 'status');
  assert.equal(withClass(last, 'sr-only')[0].textContent, 'agy is working');
});

test('an unchanged message object reuses its DOM node across renders', () => {
  const doc = createFakeDocument();
  const container = doc.createElement('main');
  const renderer = createTranscriptRenderer(doc);
  const message = { id: 'a1', role: 'assistant', text: 'stable' };
  renderer.render(container, [message], { busy: false });
  const first = container.childNodes[0];
  renderer.render(container, [message, { id: 'a2', role: 'assistant', text: 'new' }], { busy: false });
  assert.equal(container.childNodes[0], first);
});

test('a replaced step object (ACTIVE to DONE) re-renders the row with the new state', () => {
  const doc = createFakeDocument();
  const container = doc.createElement('main');
  const renderer = createTranscriptRenderer(doc);
  renderer.render(container, [ACTIVE_STEP], { busy: true });
  renderer.render(container, [{ ...ACTIVE_STEP, state: 'DONE' }], { busy: false });
  assert.equal(withClass(container, 'step')[0].getAttribute('data-state'), 'done');
});
