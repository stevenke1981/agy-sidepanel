import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRunOptions } from '../src/lib/protocol.js';
import {
  buildRunOptions, decidePageContext, quoteSelection, sendButtonView, shouldSendOnKey, unavailableNotice
} from '../src/ui/send-plan.js';
import { composeFromPending, parsePendingPrompt } from '../src/ui/pending.js';
import { appendLocalMessage, makeLocalId, makeLocalMessage } from '../src/ui/local-messages.js';

const SETTINGS = Object.freeze({ model: '', effort: '', mode: 'plan', cwd: '' });

test('decidePageContext uses page context in plan and accept-edits modes without skip', () => {
  assert.deepEqual(decidePageContext({ wantPage: true, skipPermissions: false, mode: 'plan' }), { use: true, notice: '' });
  assert.equal(decidePageContext({ wantPage: true, skipPermissions: false, mode: 'accept-edits' }).use, true);
});

test('decidePageContext sends without page context (with a notice) in skip or auto modes', () => {
  const skipped = decidePageContext({ wantPage: true, skipPermissions: true, mode: 'plan' });
  assert.equal(skipped.use, false);
  assert.match(skipped.notice, /skip-permissions or auto mode/);
  assert.equal(decidePageContext({ wantPage: true, skipPermissions: false, mode: 'auto' }).use, false);
});

test('decidePageContext is silent when the user did not want page context', () => {
  assert.deepEqual(decidePageContext({ wantPage: false, skipPermissions: true, mode: 'auto' }), { use: false, notice: '' });
});

test('unavailableNotice explains the fallback for every known reason and for unknown ones', () => {
  assert.match(unavailableNotice('no-permission'), /not shared/);
  assert.match(unavailableNotice('restricted-page'), /Sent without page context\.$/);
  assert.match(unavailableNotice('mystery'), /Could not read this page\.\s+Sent without page context\.$/);
});

test('buildRunOptions output passes the shared protocol validator with page context', () => {
  // Arrange
  const options = buildRunOptions({
    settings: { ...SETTINGS, model: 'm-1', effort: 'high', mode: 'plan', cwd: 'C:\\work' },
    skipPermissions: false,
    hasPageContext: true,
    conversationId: '123e4567-e89b-12d3-a456-426614174000'
  });
  // Act
  const result = validateRunOptions(options);
  // Assert
  assert.equal(result.ok, true, result.message);
  assert.equal(result.value.hasPageContext, true);
  assert.equal(result.value.conversationId, '123e4567-e89b-12d3-a456-426614174000');
});

test('buildRunOptions output with empty settings is valid and defaults to agy defaults', () => {
  const options = buildRunOptions({ settings: { model: '', effort: '', mode: '', cwd: '' }, skipPermissions: false, hasPageContext: false, conversationId: null });
  assert.equal(options.mode, 'plan');
  assert.equal(options.conversationId, '');
  assert.equal(validateRunOptions(options).ok, true);
});

test('protocol rejects page context combined with skip or auto, so the UI gate is required', () => {
  const combined = buildRunOptions({ settings: { ...SETTINGS, mode: 'auto' }, skipPermissions: false, hasPageContext: true, conversationId: null });
  assert.equal(validateRunOptions(combined).ok, false);
});

test('shouldSendOnKey: Enter and Ctrl+Enter send; Shift+Enter, Alt+Enter and IME composition do not', () => {
  const key = (overrides) => ({ key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, isComposing: false, ...overrides });
  assert.equal(shouldSendOnKey(key({})), true);
  assert.equal(shouldSendOnKey(key({ ctrlKey: true })), true);
  assert.equal(shouldSendOnKey(key({ shiftKey: true })), false);
  assert.equal(shouldSendOnKey(key({ altKey: true })), false);
  assert.equal(shouldSendOnKey(key({ isComposing: true })), false);
  assert.equal(shouldSendOnKey(key({ key: 'a' })), false);
});

test('quoteSelection prefixes every line with a blockquote marker', () => {
  assert.equal(quoteSelection('one\r\ntwo'), '> one\n> two');
});

test('sendButtonView switches between Send and Stop', () => {
  assert.equal(sendButtonView(false).label, 'Send');
  assert.equal(sendButtonView(true).label, 'Stop');
  assert.equal(sendButtonView(true).stop, true);
});

test('parsePendingPrompt accepts the documented shapes and aliases, and rejects junk', () => {
  assert.deepEqual(parsePendingPrompt({ kind: 'page' }), { kind: 'page' });
  assert.deepEqual(parsePendingPrompt({ kind: 'selection', selection: 'abc' }), { kind: 'selection', selection: 'abc' });
  assert.deepEqual(parsePendingPrompt({ type: 'selection', text: 'abc' }), { kind: 'selection', selection: 'abc' });
  assert.equal(parsePendingPrompt({ kind: 'selection', selection: '   ' }), null);
  assert.equal(parsePendingPrompt({ kind: 'other' }), null);
  assert.equal(parsePendingPrompt(null), null);
  assert.equal(parsePendingPrompt('page'), null);
});

test('composeFromPending quotes a selection above existing text and always enables page context', () => {
  const withText = composeFromPending({ kind: 'selection', selection: 'x' }, 'Why?');
  assert.deepEqual(withText, { text: '> x\n\nWhy?', includePage: true });
  const empty = composeFromPending({ kind: 'selection', selection: 'x' }, '');
  assert.equal(empty.text, '> x');
  const page = composeFromPending({ kind: 'page' }, 'keep me');
  assert.deepEqual(page, { text: 'keep me', includePage: true });
});

test('appendLocalMessage returns a new state and never mutates the previous one', () => {
  // Arrange
  const before = { messages: [{ id: 'a', role: 'user', text: 'hi' }], running: false };
  // Act
  const after = appendLocalMessage(before, makeLocalMessage('local-1', 'note', 'FYI'));
  // Assert
  assert.equal(before.messages.length, 1);
  assert.equal(after.messages.length, 2);
  assert.notEqual(after, before);
  assert.equal(after.messages[1].role, 'note');
  assert.equal(after.messages[1].reqId, null);
});

test('makeLocalId yields distinct ids even within the same millisecond', () => {
  const ids = new Set([makeLocalId(1), makeLocalId(1), makeLocalId(1)]);
  assert.equal(ids.size, 3);
});
