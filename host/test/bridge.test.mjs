import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createBridge } from '../src/bridge.mjs';
import { buildStdinPayload } from '../src/agy.mjs';
import { PROTOCOL_VERSION } from '../../extension/src/lib/protocol.js';

const LOCAL = 'C:\\Users\\tester\\AppData\\Local';
const FAKE_AGY = 'C:\\agy\\agy.exe';
const IDE_DIR = path.win32.join(LOCAL, 'Programs', 'Antigravity IDE');
const IDE_EXE = path.win32.join(IDE_DIR, 'Antigravity IDE.exe');
const IDE_CLI = path.win32.join(IDE_DIR, 'resources', 'app', 'out', 'cli.js');
const DEFAULT_CWD = path.win32.join(LOCAL, 'agy-bridge', 'workspace');
const BASE_ARGS = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print='];
const PROMPT = 'Reply with exactly: pong';

let nextPid = 4000;

function fakeChild({ pid = nextPid++ } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    data: '',
    ended: false,
    on() {},
    end(chunk = '') {
      this.data += chunk;
      this.ended = true;
    },
  };
  child.kill = () => true;
  child.unref = () => {};
  return child;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function emitLines(child, objects) {
  const text = objects.map((o) => `${typeof o === 'string' ? o : JSON.stringify(o)}\n`).join('');
  child.stdout.emit('data', Buffer.from(text, 'utf8'));
}

function harness(opts = {}) {
  const sent = [];
  const spawns = [];
  const children = [];
  const killed = [];
  const dirs = new Set(opts.dirs ?? []);
  const existing = new Set([FAKE_AGY, ...(opts.existing ?? [])]);
  const spawnImpl = (exe, args, spawnOpts) => {
    spawns.push({ exe, args, opts: spawnOpts });
    if (opts.spawnError) throw opts.spawnError;
    const child = fakeChild();
    if (opts.noPid) child.pid = undefined; // Node leaves pid undefined when the process was never created
    children.push(child);
    return child;
  };
  const defaultKill = async (child) => {
    killed.push(child);
    child.emit('close', null, null);
  };
  const bridge = createBridge({
    send: (msg) => sent.push(msg),
    spawnImpl,
    env: { LOCALAPPDATA: LOCAL, AGY_PATH: FAKE_AGY, ...opts.env },
    fsImpl: {
      existsSync: (p) => existing.has(p),
      isDirectory: (p) => dirs.has(p),
      mkdirSync() {},
      appendFileSync() {},
    },
    probeVersion: async () => '1.5.9',
    killTree: opts.killTree ?? defaultKill,
    idleTimeoutMs: opts.idleTimeoutMs,
  });
  return { bridge, sent, spawns, children, killed };
}

function runMsg(reqId, extra = {}) {
  return {
    type: 'run',
    reqId,
    prompt: PROMPT,
    options: { model: 'gemini-3.8-flash-low' },
    ...extra,
  };
}

const typesOf = (sent) => sent.map((m) => m.type);

test('RUN streams EVENT frames in order and ends with exactly one EXIT', async () => {
  const h = harness();
  await h.bridge.handle(runMsg('r1'));
  const [child] = h.children;
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].exe, FAKE_AGY);
  assert.deepEqual(h.spawns[0].args, [...BASE_ARGS, '--model=gemini-3.8-flash-low']);
  assert.equal(h.spawns[0].opts.shell, false);
  assert.equal(h.spawns[0].opts.windowsHide, true);
  assert.equal(h.spawns[0].opts.cwd, DEFAULT_CWD);
  assert.equal(child.stdin.data, buildStdinPayload(PROMPT));
  assert.equal(child.stdin.ended, true);
  emitLines(child, [
    { event: 'init', init: { model: 'm' } },
    { event: 'step_update', step_update: { text_delta: 'pong' } },
    { event: 'result', result: { status: 'SUCCESS', response: 'pong' } },
  ]);
  child.emit('close', 0, null);
  assert.deepEqual(typesOf(h.sent), ['event', 'event', 'event', 'exit']);
  assert.deepEqual(h.sent.at(-1), { type: 'exit', reqId: 'r1', code: 0, signal: null, cancelled: false });
});

test('invalid RUN options produce ERROR BAD_REQUEST and no EXIT or spawn', async () => {
  const h = harness();
  await h.bridge.handle(runMsg('r2', { options: { mode: 'bogus' } }));
  await h.bridge.handle(runMsg('r3', { options: { skipPermissions: true, hasPageContext: true } }));
  await h.bridge.handle(runMsg('r4', { prompt: '   ' }));
  assert.deepEqual(typesOf(h.sent), ['error', 'error', 'error']);
  assert.deepEqual(h.sent[0], { type: 'error', reqId: 'r2', code: 'BAD_REQUEST', message: 'invalid mode' });
  assert.equal(h.sent[1].code, 'BAD_REQUEST');
  assert.equal(h.spawns.length, 0);
});

test('a reqId reused while or after a run is accepted gets DUPLICATE_REQ', async () => {
  const h = harness();
  await h.bridge.handle(runMsg('dup'));
  await h.bridge.handle(runMsg('dup'));
  h.children[0].emit('close', 0, null);
  await h.bridge.handle(runMsg('dup'));
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(typesOf(h.sent), ['error', 'exit', 'error']);
  assert.equal(h.sent[0].code, 'DUPLICATE_REQ');
  assert.equal(h.sent[2].code, 'DUPLICATE_REQ');
});

test('a fourth concurrent RUN gets TOO_MANY_RUNS without an EXIT', async () => {
  const h = harness();
  for (const id of ['a1', 'a2', 'a3']) await h.bridge.handle(runMsg(id));
  await h.bridge.handle(runMsg('a4'));
  assert.equal(h.spawns.length, 3);
  assert.deepEqual(h.sent, [{
    type: 'error', reqId: 'a4', code: 'TOO_MANY_RUNS', message: 'too many concurrent runs',
  }]);
});

test('cancel acks with CANCELLED, drops later output, and ends with EXIT cancelled:true', async () => {
  const h = harness();
  await h.bridge.handle(runMsg('c1'));
  const [child] = h.children;
  emitLines(child, [{ event: 'init' }]);
  await h.bridge.handle({ type: 'cancel', reqId: 'c1' });
  emitLines(child, [{ event: 'late' }]);
  await settle();
  assert.deepEqual(typesOf(h.sent), ['event', 'cancelled', 'exit']);
  assert.equal(h.killed.length, 1);
  assert.equal(h.killed[0], child);
  assert.deepEqual(h.sent.at(-1), { type: 'exit', reqId: 'c1', code: null, signal: null, cancelled: true });
});

test('cancel of an unknown reqId produces ERROR UNKNOWN_RUN', async () => {
  const h = harness();
  await h.bridge.handle({ type: 'cancel', reqId: 'nope' });
  assert.deepEqual(h.sent, [{ type: 'error', reqId: 'nope', code: 'UNKNOWN_RUN', message: 'no active run with this reqId' }]);
});

test('synchronous spawn failure gives ERROR SPAWN_FAILED then EXIT code null', async () => {
  const h = harness({ spawnError: new Error('spawn EPERM') });
  await h.bridge.handle(runMsg('s1'));
  assert.deepEqual(typesOf(h.sent), ['error', 'exit']);
  assert.equal(h.sent[0].code, 'SPAWN_FAILED');
  assert.deepEqual(h.sent[1], { type: 'exit', reqId: 's1', code: null, signal: null, cancelled: false });
});

test('asynchronous spawn failure (no pid, then error) gives ERROR SPAWN_FAILED then EXIT', async () => {
  const h = harness({ noPid: true });
  await h.bridge.handle(runMsg('s2'));
  const enoent = Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' });
  h.children[0].emit('error', enoent);
  h.children[0].emit('close', -2, null);
  assert.deepEqual(typesOf(h.sent), ['error', 'exit']);
  assert.equal(h.sent[0].code, 'SPAWN_FAILED');
  assert.equal(h.sent[1].code, null);
});

test('non-JSON stdout lines become STDERR while JSON lines remain EVENT', async () => {
  const h = harness();
  await h.bridge.handle(runMsg('n1'));
  h.children[0].stdout.emit('data', Buffer.from('plain warning\n{"event":"init"}\n', 'utf8'));
  h.children[0].emit('close', 0, null);
  assert.deepEqual(typesOf(h.sent), ['stderr', 'event', 'exit']);
  assert.deepEqual(h.sent[0], { type: 'stderr', reqId: 'n1', text: 'plain warning' });
});

test('stderr output is forwarded as STDERR for the run', async () => {
  const h = harness();
  await h.bridge.handle(runMsg('e1'));
  h.children[0].stderr.emit('data', Buffer.from('boom\n'));
  assert.deepEqual(h.sent, [{ type: 'stderr', reqId: 'e1', text: 'boom' }]);
});

test('HELLO with a different protocol gets ERROR PROTOCOL_MISMATCH', async () => {
  const h = harness();
  await h.bridge.handle({ type: 'hello', protocol: PROTOCOL_VERSION + 1 });
  assert.deepEqual(h.sent, [{
    type: 'error', reqId: null, code: 'PROTOCOL_MISMATCH', message: `host speaks protocol ${PROTOCOL_VERSION}`,
  }]);
});

test('HELLO reports paths, versions, IDE availability and default cwd', async () => {
  const h = harness();
  await h.bridge.handle({ type: 'hello', protocol: PROTOCOL_VERSION });
  const [hello] = h.sent;
  assert.equal(hello.type, 'hello');
  assert.equal(hello.protocol, PROTOCOL_VERSION);
  assert.equal(hello.agyPath, FAKE_AGY);
  assert.equal(hello.agyVersion, '1.5.9');
  assert.equal(hello.ideAvailable, false);
  assert.equal(hello.defaultCwd, DEFAULT_CWD);
});

test('MODELS spawns agy models and parses the TAB-separated list', async () => {
  const h = harness();
  const pending = h.bridge.handle({ type: 'models', reqId: 'm1' });
  const [child] = h.children;
  assert.deepEqual(h.spawns[0].args, ['models']);
  emitLines(child, ['Fetching available models...', 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)']);
  child.emit('close', 0, null);
  await pending;
  assert.deepEqual(h.sent, [{
    type: 'models', reqId: 'm1', models: [{ id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' }],
  }]);
});

test('idle timeout kills the run and EXIT reports cancelled:false', async () => {
  const h = harness({ idleTimeoutMs: 20 });
  await h.bridge.handle(runMsg('i1'));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(h.killed.length, 1);
  assert.deepEqual(typesOf(h.sent), ['stderr', 'exit']);
  assert.equal(h.sent[1].cancelled, false);
});

test('shutdown kills every active run and resolves after the kills complete', async () => {
  const h = harness();
  await h.bridge.handle(runMsg('x1'));
  await h.bridge.handle(runMsg('x2'));
  await h.bridge.shutdown();
  assert.equal(h.killed.length, 2);
  const exits = h.sent.filter((m) => m.type === 'exit');
  assert.deepEqual(exits.map((m) => m.cancelled), [true, true]);
});

test('a cwd that is not an existing directory gets ERROR BAD_REQUEST', async () => {
  const h = harness();
  await h.bridge.handle(runMsg('w1', { options: { cwd: 'C:\\does\\not\\exist' } }));
  assert.deepEqual(h.sent, [{
    type: 'error', reqId: 'w1', code: 'BAD_REQUEST', message: 'cwd must be an existing directory',
  }]);
  assert.equal(h.spawns.length, 0);
});

test('an explicit existing cwd is used as the spawn cwd', async () => {
  const dir = 'D:\\work\\repo';
  const h = harness({ dirs: [dir] });
  await h.bridge.handle(runMsg('w2', { options: { cwd: dir } }));
  assert.equal(h.spawns[0].opts.cwd, dir);
});

test('OPEN_IDE without an installed IDE gets ERROR IDE_NOT_FOUND', async () => {
  const h = harness({ existing: ['C:\\proj'] });
  await h.bridge.handle({ type: 'openIde', reqId: 'o1', path: 'C:\\proj' });
  assert.deepEqual(h.sent, [{
    type: 'error', reqId: 'o1', code: 'IDE_NOT_FOUND', message: 'Antigravity IDE not found',
  }]);
});

test('OPEN_IDE launches Electron as Node on cli.js with the target path and replies OK', async () => {
  const h = harness({ existing: [IDE_EXE, IDE_CLI, 'C:\\proj'] });
  await h.bridge.handle({ type: 'openIde', reqId: 'o2', path: 'C:\\proj' });
  const [spawn] = h.spawns;
  assert.equal(spawn.exe, IDE_EXE);
  assert.deepEqual(spawn.args, [IDE_CLI, 'C:\\proj']);
  assert.equal(spawn.opts.shell, false);
  assert.equal(spawn.opts.detached, true);
  assert.equal(spawn.opts.stdio, 'ignore');
  assert.equal(spawn.opts.env.ELECTRON_RUN_AS_NODE, '1');
  assert.deepEqual(h.sent, [{ type: 'ok', reqId: 'o2' }]);
});

test('OPEN_IDE rejects a relative or UNC path as BAD_REQUEST', async () => {
  const h = harness({ existing: [IDE_EXE, IDE_CLI] });
  await h.bridge.handle({ type: 'openIde', reqId: 'o3', path: '\\\\server\\share' });
  assert.equal(h.sent[0].code, 'BAD_REQUEST');
  assert.equal(h.spawns.length, 0);
});

test('unknown message types and non-object messages get ERROR BAD_REQUEST', async () => {
  const h = harness();
  await h.bridge.handle({ type: 'bogus', reqId: 'u1' });
  await h.bridge.handle(42);
  assert.deepEqual(h.sent.map((m) => [m.code, m.reqId]), [['BAD_REQUEST', 'u1'], ['BAD_REQUEST', null]]);
});

test('reportFrameError emits ERROR BAD_REQUEST with reqId null', () => {
  const h = harness();
  h.bridge.reportFrameError(new Error('invalid JSON frame'));
  assert.deepEqual(h.sent, [{ type: 'error', reqId: null, code: 'BAD_REQUEST', message: 'invalid JSON frame' }]);
});
