import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  buildArgs, buildStdinPayload, defaultCwd, parseModels, resolveAgyPath, resolveIde, truncateForHost,
} from '../src/agy.mjs';

const LIMIT = 1_000_000;
const existing = (...paths) => {
  const set = new Set(paths);
  return (p) => set.has(p);
};

test('resolveAgyPath prefers AGY_PATH when it exists', () => {
  const env = { AGY_PATH: 'D:\\custom\\agy.exe', LOCALAPPDATA: 'C:\\L' };
  const found = resolveAgyPath({ env, fsExists: existing('D:\\custom\\agy.exe', 'C:\\L\\agy\\bin\\agy.exe') });
  assert.equal(found, 'D:\\custom\\agy.exe');
});

test('resolveAgyPath skips a missing AGY_PATH and uses %LOCALAPPDATA%\\agy\\bin\\agy.exe', () => {
  const env = { AGY_PATH: 'D:\\gone\\agy.exe', LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' };
  const target = 'C:\\Users\\t\\AppData\\Local\\agy\\bin\\agy.exe';
  assert.equal(resolveAgyPath({ env, fsExists: existing(target) }), target);
});

test('resolveAgyPath falls back to PATH, checking agy.exe before agy', () => {
  const dirA = path.join('/opt', 'a');
  const dirB = path.join('/opt', 'b');
  const env = { PATH: [dirA, dirB].join(path.delimiter) };
  const found = resolveAgyPath({ env, fsExists: existing(path.join(dirB, 'agy')) });
  assert.equal(found, path.join(dirB, 'agy'));
  const both = resolveAgyPath({ env, fsExists: existing(path.join(dirA, 'agy.exe'), path.join(dirA, 'agy')) });
  assert.equal(both, path.join(dirA, 'agy.exe'));
});

test('resolveAgyPath returns null when nothing is found', () => {
  assert.equal(resolveAgyPath({ env: { PATH: '' }, fsExists: () => false }), null);
});

test('buildArgs returns the fixed stream-json prefix with single-argument flag forms', () => {
  const args = buildArgs({
    model: 'gemini-3.8-flash-low', effort: 'high', mode: 'plan', conversationId: 'abcdef12-3456',
  });
  assert.deepEqual(args, [
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--print=',
    '--model=gemini-3.8-flash-low', '--effort=high', '--mode=plan', '--conversation=abcdef12-3456',
  ]);
});

test('buildArgs with no optional options contains only the fixed prefix', () => {
  assert.deepEqual(buildArgs({}), [
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--print=',
  ]);
});

test('buildArgs adds --dangerously-skip-permissions only when skipPermissions is true', () => {
  assert.equal(buildArgs({ skipPermissions: false }).includes('--dangerously-skip-permissions'), false);
  assert.equal(buildArgs({}).includes('--dangerously-skip-permissions'), false);
  const args = buildArgs({ model: 'm1', skipPermissions: true });
  assert.deepEqual(args.slice(-2), ['--model=m1', '--dangerously-skip-permissions']);
});

test('buildArgs never splits a flag value into a separate argument', () => {
  const args = buildArgs({ model: 'a.b-c' });
  assert.ok(args.includes('--model=a.b-c'));
  assert.equal(args.includes('--model'), false);
  assert.equal(args.includes('a.b-c'), false);
});

test('buildStdinPayload produces one newline-terminated user event line', () => {
  assert.equal(
    buildStdinPayload('hi "quoted" 中文'),
    '{"event":"user","message":{"role":"user","content":"hi \\"quoted\\" 中文"}}\n',
  );
});

test('parseModels keeps TAB-separated lines and skips the Fetching header', () => {
  const stdout = 'Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\r\nclaude-x\tClaude X\n\n';
  assert.deepEqual(parseModels(stdout), [
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    { id: 'claude-x', label: 'Claude X' },
  ]);
});

test('parseModels returns an empty list for empty or header-only output', () => {
  assert.deepEqual(parseModels(''), []);
  assert.deepEqual(parseModels('Fetching available models...\n'), []);
});

test('resolveIde finds the exe and cli.js when both exist', () => {
  const env = { LOCALAPPDATA: 'C:\\L' };
  const dir = path.win32.join('C:\\L', 'Programs', 'Antigravity IDE');
  const exe = path.win32.join(dir, 'Antigravity IDE.exe');
  const cli = path.win32.join(dir, 'resources', 'app', 'out', 'cli.js');
  assert.deepEqual(resolveIde({ env, fsExists: existing(exe, cli) }), { exe, cliJs: cli });
  assert.equal(resolveIde({ env, fsExists: existing(exe) }), null);
  assert.equal(resolveIde({ env: {}, fsExists: () => true }), null);
});

test('defaultCwd creates %LOCALAPPDATA%\\agy-bridge\\workspace recursively', () => {
  const calls = [];
  const dir = defaultCwd({
    env: { LOCALAPPDATA: 'C:\\L' },
    mkdirSync: (p, opts) => calls.push([p, opts]),
  });
  assert.equal(dir, path.win32.join('C:\\L', 'agy-bridge', 'workspace'));
  assert.deepEqual(calls, [[dir, { recursive: true }]]);
});

test('defaultCwd throws when LOCALAPPDATA is unset instead of falling back to home', () => {
  assert.throws(() => defaultCwd({ env: {}, mkdirSync: () => {} }), /LOCALAPPDATA/);
});

test('truncateForHost returns small messages unchanged', () => {
  const msg = { type: 'event', reqId: 'r1', event: { event: 'step_update', step_update: { text_delta: 'hi' } } };
  assert.equal(truncateForHost(msg), msg);
});

test('truncateForHost keeps CJK text under 1 MB by UTF-8 bytes and marks it truncated', () => {
  const text = '中'.repeat(400_000); // 1.2 MB in UTF-8
  const msg = {
    type: 'event', reqId: 'r1', event: { event: 'step_update', step_update: { state: 'ACTIVE', text_delta: text } },
  };
  const out = truncateForHost(msg, LIMIT);
  const size = Buffer.byteLength(JSON.stringify(out), 'utf8');
  assert.ok(size <= LIMIT, `size ${size} exceeds limit`);
  assert.equal(out.event.step_update.truncated, true);
  const kept = out.event.step_update.text_delta;
  assert.ok(kept.length > 0 && kept.length < text.length);
  assert.equal(kept, text.slice(0, kept.length), 'kept text must be a clean prefix');
  assert.equal(kept.includes('\uFFFD'), false);
});

test('truncateForHost truncates a result.response field and keeps it valid', () => {
  const response = 'abc中'.repeat(300_000);
  const msg = { type: 'event', reqId: 'r2', event: { event: 'result', result: { status: 'SUCCESS', response } } };
  const out = truncateForHost(msg, LIMIT);
  assert.ok(Buffer.byteLength(JSON.stringify(out), 'utf8') <= LIMIT);
  assert.equal(out.event.result.truncated, true);
  assert.equal(out.event.result.status, 'SUCCESS');
});

test('truncateForHost replaces a non-text oversize event with an oversize marker', () => {
  const msg = { type: 'event', reqId: 'r3', event: { event: 'init', init: { tools: 'x'.repeat(1_100_000) } } };
  const out = truncateForHost(msg, LIMIT);
  assert.equal(out.type, 'event');
  assert.equal(out.reqId, 'r3');
  assert.equal(out.event.event, 'oversize');
  assert.equal(out.event.originalEvent, 'init');
  assert.ok(out.event.bytes > LIMIT);
});

test('truncateForHost truncates oversize STDERR text at top level', () => {
  const msg = { type: 'stderr', reqId: 'r4', text: 'e'.repeat(1_200_000) };
  const out = truncateForHost(msg, LIMIT);
  assert.equal(out.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(out), 'utf8') <= LIMIT);
});
