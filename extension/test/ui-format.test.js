import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectingView, errorText, formatConnection, formatContextChip, formatCount, formatDuration, formatHost,
  formatSessionBadge, formatUsage, missingView
} from '../src/ui/view-format.js';
import { contextViewFor, REASON_NOTE } from '../src/ui/context-view.js';
import { modelOptions } from '../src/ui/controls.js';

test('formatCount groups thousands and tolerates bad input', () => {
  assert.equal(formatCount(1234567), '1,234,567');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(undefined), '0');
  assert.equal(formatCount(Number.NaN), '0');
});

test('formatUsage renders in/out/total and is empty without usage', () => {
  const usage = { input_tokens: 1200, output_tokens: 56, total_tokens: 1256 };
  assert.equal(formatUsage(usage), 'in 1,200 · out 56 · total 1,256');
  assert.equal(formatUsage(null), '');
});

test('formatSessionBadge joins model, mode and tool count, dropping empty parts', () => {
  assert.equal(formatSessionBadge({ model: 'm-1', permissionMode: 'plan', toolsCount: 12 }), 'm-1 · plan · 12 tools');
  assert.equal(formatSessionBadge({ model: '', permissionMode: 'plan', toolsCount: 0 }), 'plan');
  assert.equal(formatSessionBadge({}), '');
});

test('formatDuration uses tenths below a minute and m/s above', () => {
  assert.equal(formatDuration(0.42), '0.4s');
  assert.equal(formatDuration(125), '2m 5s');
  assert.equal(formatDuration(undefined), '');
  assert.equal(formatDuration(-1), '');
});

test('formatHost returns the host with port and empty string for invalid URLs', () => {
  assert.equal(formatHost('https://example.com:8443/a?b=1'), 'example.com:8443');
  assert.equal(formatHost('not a url'), '');
});

test('formatContextChip maps summary to title, host and chars, with an untitled fallback', () => {
  assert.deepEqual(formatContextChip({ title: 'Docs', url: 'https://a.test/x', chars: 20000 }), {
    title: 'Docs',
    host: 'a.test',
    chars: '20,000 chars'
  });
  assert.equal(formatContextChip({ title: '', url: '', chars: 3 }).title, 'Untitled page');
  assert.equal(formatContextChip(null), null);
});

test('connection views: connecting, connected with version, and host missing', () => {
  assert.deepEqual(connectingView(), { state: 'connecting', text: 'connecting…' });
  assert.deepEqual(formatConnection({ agyVersion: '1.5.9' }), { state: 'connected', text: 'connected · agy v1.5.9' });
  assert.equal(formatConnection({}).text, 'connected');
  assert.equal(missingView().state, 'missing');
});

test('errorText never returns an empty string', () => {
  assert.equal(errorText(new Error('boom')), 'boom');
  assert.equal(errorText('disconnected'), 'disconnected');
  assert.equal(errorText(new Error('')), 'Unknown error');
  assert.equal(errorText(42), 'Unknown error');
});

test('contextViewFor: off when the toggle is off, regardless of the page', () => {
  const view = contextViewFor({ include: false, dropped: false, result: { ok: true }, summary: null });
  assert.equal(view.mode, 'off');
  assert.equal(view.chip, null);
});

test('contextViewFor: dropped-for-message and checking states carry notes', () => {
  assert.equal(contextViewFor({ include: true, dropped: true, result: null, summary: null }).mode, 'dropped');
  const checking = contextViewFor({ include: true, dropped: false, result: null, summary: null });
  assert.equal(checking.mode, 'checking');
  assert.equal(checking.note, 'Reading page…');
});

test('contextViewFor: ok result shows a chip; no-permission exposes the origin for "Allow this site"', () => {
  const chip = contextViewFor({
    include: true,
    dropped: false,
    result: { ok: true },
    summary: { title: 'T', url: 'https://x.test/', chars: 5 }
  });
  assert.equal(chip.mode, 'chip');
  assert.equal(chip.chip.host, 'x.test');

  const denied = contextViewFor({
    include: true,
    dropped: false,
    result: { ok: false, reason: 'no-permission', origin: 'https://x.test' },
    summary: null
  });
  assert.equal(denied.mode, 'no-permission');
  assert.equal(denied.origin, 'https://x.test');
  assert.equal(denied.note, REASON_NOTE['no-permission']);
});

test('contextViewFor: restricted pages are muted; unknown reasons fall back to a generic note', () => {
  const restricted = contextViewFor({ include: true, dropped: false, result: { ok: false, reason: 'restricted-page' }, summary: null });
  assert.equal(restricted.mode, 'restricted');
  const unknown = contextViewFor({ include: true, dropped: false, result: { ok: false, reason: 'weird' }, summary: null });
  assert.equal(unknown.mode, 'unavailable');
  assert.equal(unknown.note, REASON_NOTE.error);
});

test('modelOptions puts default first and keeps a saved model the host no longer lists', () => {
  const options = modelOptions([{ id: 'a', label: 'Alpha' }, { id: '', label: 'skip' }, null], 'gone');
  assert.deepEqual(options, [
    { value: '', label: 'default' },
    { value: 'a', label: 'Alpha' },
    { value: 'gone', label: 'gone (saved)' }
  ]);
});

test('modelOptions falls back to the id when a label is missing and tolerates non-arrays', () => {
  assert.deepEqual(modelOptions([{ id: 'm' }], ''), [
    { value: '', label: 'default' },
    { value: 'm', label: 'm' }
  ]);
  assert.deepEqual(modelOptions(undefined, ''), [{ value: '', label: 'default' }]);
});
