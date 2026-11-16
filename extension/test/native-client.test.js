import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_ERR, NativeClient } from '../src/lib/native-client.js';
import { ERR, PROTOCOL_VERSION, REQ, RES } from '../src/lib/protocol.js';

/** Minimal event hub matching chrome.runtime.Port listeners. */
function listenerList() {
  const fns = [];
  return {
    addListener: (fn) => fns.push(fn),
    fire: (arg) => fns.forEach((fn) => fn(arg)),
  };
}

class FakePort {
  constructor() {
    this.sent = [];
    this.disconnected = false;
    this.failPost = false;
    this.onMessage = listenerList();
    this.onDisconnect = listenerList();
  }

  postMessage(msg) {
    if (this.failPost) throw new Error('Attempting to use a disconnected port object');
    this.sent.push(msg);
  }

  disconnect() {
    this.disconnected = true;
  }

  receive(msg) {
    this.onMessage.fire(msg);
  }

  drop() {
    this.onDisconnect.fire(undefined);
  }
}

/**
 * @param {object} [overrides]
 * @returns {{client: NativeClient, ports: FakePort[], state: {lastError: string|null, connectError: Error|null}, current: () => FakePort}}
 */
function harness(overrides = {}) {
  const ports = [];
  const state = { lastError: null, connectError: null };
  let seq = 0;
  const client = new NativeClient({
    connectNative: () => {
      if (state.connectError) throw state.connectError;
      const port = new FakePort();
      ports.push(port);
      return port;
    },
    newReqId: () => `r${String(++seq).padStart(4, '0')}`,
    getLastError: () => state.lastError,
    timeoutMs: 1000,
    ...overrides,
  });
  return { client, ports, state, current: () => ports.at(-1) };
}

test('hello sends the protocol version and resolves with the host HELLO message', async () => {
  const { client, current } = harness();
  const pending = client.hello();
  assert.deepEqual(current().sent, [{ type: REQ.HELLO, protocol: PROTOCOL_VERSION }]);
  current().receive({ type: RES.HELLO, protocol: PROTOCOL_VERSION, agyVersion: '1.5.9', defaultCwd: 'C:\\w' });
  const info = await pending;
  assert.equal(info.agyVersion, '1.5.9');
  assert.equal(info.defaultCwd, 'C:\\w');
});

test('hello rejects when the host replies with PROTOCOL_MISMATCH', async () => {
  const { client, current } = harness();
  const pending = client.hello();
  current().receive({ type: RES.ERROR, reqId: null, code: ERR.PROTOCOL_MISMATCH, message: 'need 1' });
  await assert.rejects(pending, /PROTOCOL_MISMATCH: need 1/);
});

test('hello rejects when the HELLO reply carries a different protocol version', async () => {
  const { client, current } = harness();
  const pending = client.hello();
  current().receive({ type: RES.HELLO, protocol: PROTOCOL_VERSION + 1 });
  await assert.rejects(pending, /host protocol 2, extension 1/);
});

test('listModels sends a models request and keeps only well-formed entries', async () => {
  const { client, current } = harness();
  const pending = client.listModels();
  const req = current().sent[0];
  assert.equal(req.type, REQ.MODELS);
  current().receive({ type: RES.MODELS, reqId: req.reqId, models: [{ id: 'm1', label: 'Model 1' }, { label: 'no id' }, null] });
  assert.deepEqual(await pending, [{ id: 'm1', label: 'Model 1' }]);
});

test('concurrent runs route their messages by reqId and EXIT ends each run', async () => {
  const { client, current } = harness();
  const got = { a: [], b: [] };
  const runA = client.run('prompt a', { model: 'x' }, (m) => got.a.push(m));
  const runB = client.run('prompt b', {}, (m) => got.b.push(m));
  const port = current();
  assert.deepEqual(port.sent[0], { type: REQ.RUN, reqId: runA.reqId, prompt: 'prompt a', options: { model: 'x' } });
  port.receive({ type: RES.EVENT, reqId: runB.reqId, event: { event: 'step_update' } });
  port.receive({ type: RES.EVENT, reqId: runA.reqId, event: { event: 'init' } });
  port.receive({ type: RES.EXIT, reqId: runA.reqId, code: 0, signal: null, cancelled: false });
  port.receive({ type: RES.EVENT, reqId: runA.reqId, event: { event: 'late' } });
  port.receive({ type: RES.EXIT, reqId: runB.reqId, code: 0, signal: null, cancelled: false });
  assert.deepEqual(got.a.map((m) => m.type), [RES.EVENT, RES.EXIT]);
  assert.deepEqual(got.b.map((m) => m.type), [RES.EVENT, RES.EXIT]);
});

test('cancel sends a cancel request and the run ends with EXIT cancelled:true', () => {
  const { client, current } = harness();
  const got = [];
  const run = client.run('p', {}, (m) => got.push(m));
  assert.equal(run.cancel(), true);
  assert.deepEqual(current().sent[1], { type: REQ.CANCEL, reqId: run.reqId });
  current().receive({ type: RES.CANCELLED, reqId: run.reqId });
  current().receive({ type: RES.EXIT, reqId: run.reqId, code: null, signal: 'SIGTERM', cancelled: true });
  assert.deepEqual(got.map((m) => m.type), [RES.CANCELLED, RES.EXIT]);
  assert.equal(got[1].cancelled, true);
});

test('a validation ERROR without EXIT releases the run so later stale messages are dropped', () => {
  const { client, current } = harness();
  const got = [];
  const run = client.run('bad', { cwd: 'x' }, (m) => got.push(m));
  current().receive({ type: RES.ERROR, reqId: run.reqId, code: ERR.BAD_REQUEST, message: 'invalid cwd' });
  current().receive({ type: RES.EXIT, reqId: run.reqId, code: 0, signal: null, cancelled: false });
  assert.deepEqual(got.map((m) => m.type), [RES.ERROR]);
});

test('SPAWN_FAILED keeps the run open until its EXIT arrives', () => {
  const { client, current } = harness();
  const got = [];
  const run = client.run('p', {}, (m) => got.push(m));
  current().receive({ type: RES.ERROR, reqId: run.reqId, code: ERR.SPAWN_FAILED, message: 'no agy' });
  current().receive({ type: RES.EXIT, reqId: run.reqId, code: null, signal: null, cancelled: false });
  assert.deepEqual(got.map((m) => m.type), [RES.ERROR, RES.EXIT]);
});

test('disconnect rejects pending requests with the lastError message and ends runs with a synthetic EXIT', async () => {
  const { client, current, state } = harness();
  const reasons = [];
  client.onDisconnect((message) => reasons.push(message));
  const hello = client.hello();
  const models = client.listModels();
  const got = [];
  client.run('p', {}, (m) => got.push(m));
  state.lastError = 'Specified native messaging host not found.';
  current().drop();
  await assert.rejects(hello, /not found/);
  await assert.rejects(models, /not found/);
  assert.deepEqual(got.map((m) => m.type), [RES.ERROR, RES.EXIT]);
  assert.equal(got[0].code, CLIENT_ERR.DISCONNECTED);
  assert.equal(got[1].cancelled, false);
  assert.deepEqual(reasons, ['Specified native messaging host not found.']);
});

test('a run cancelled before disconnect reports cancelled:true in the synthetic EXIT', () => {
  const { client, current } = harness();
  const got = [];
  const run = client.run('p', {}, (m) => got.push(m));
  run.cancel();
  current().drop();
  assert.equal(got.at(-1).cancelled, true);
});

test('a connectNative that throws is reported as a disconnect on the next microtask', async () => {
  const { client, state, ports } = harness();
  state.connectError = new Error('boom');
  const reasons = [];
  client.onDisconnect((message) => reasons.push(message));
  await assert.rejects(client.hello(), /boom/);
  assert.equal(ports.length, 0);
  assert.deepEqual(reasons, ['boom']);
});

test('a failed postMessage fails the request through the disconnect path', async () => {
  const { client, current } = harness();
  client.connect();
  current().failPost = true;
  await assert.rejects(client.hello(), /disconnected port/);
});

test('the next request after a disconnect opens a new port', async () => {
  const { client, current, ports } = harness();
  const first = client.hello();
  current().drop();
  await assert.rejects(first);
  const second = client.hello();
  assert.equal(ports.length, 2);
  ports[1].receive({ type: RES.HELLO, protocol: PROTOCOL_VERSION });
  await second;
});

test('openIde rejects an unsafe path without connecting', async () => {
  const { client, ports } = harness();
  await assert.rejects(client.openIde('relative\\dir'), /invalid path/);
  await assert.rejects(client.openIde('\\\\server\\share'), /invalid path/);
  assert.equal(ports.length, 0);
});

test('openIde resolves on OK and rejects on ERROR', async () => {
  const { client, current } = harness();
  const ok = client.openIde('D:\\proj');
  const req = current().sent[0];
  assert.equal(req.type, REQ.OPEN_IDE);
  assert.equal(req.path, 'D:\\proj');
  current().receive({ type: RES.OK, reqId: req.reqId });
  await ok;
  const failed = client.openIde('D:\\missing');
  current().receive({ type: RES.ERROR, reqId: current().sent[1].reqId, code: ERR.IDE_NOT_FOUND, message: 'no ide' });
  await assert.rejects(failed, /IDE_NOT_FOUND: no ide/);
});

test('a request with no reply rejects with a TIMEOUT error', async () => {
  const { client } = harness({ timeoutMs: 20 });
  await assert.rejects(client.hello(), /TIMEOUT/);
});

test('onDisconnect returns an unsubscribe function', () => {
  const { client, current } = harness();
  const calls = [];
  const unsubscribe = client.onDisconnect((m) => calls.push(m));
  client.connect();
  unsubscribe();
  current().drop();
  assert.deepEqual(calls, []);
});

test('disconnect() closes the port and fails pending work', async () => {
  const { client, current } = harness();
  const pending = client.hello();
  const port = current();
  client.disconnect();
  assert.equal(port.disconnected, true);
  await assert.rejects(pending, /Disconnected by extension/);
});

test('messages for unknown reqIds and unknown types are ignored without throwing', () => {
  const { client, current } = harness();
  client.connect();
  assert.doesNotThrow(() => {
    current().receive({ type: RES.EVENT, reqId: 'rNOPE', event: {} });
    current().receive({ type: RES.EXIT, reqId: 'rNOPE', code: 0 });
    current().receive(null);
    current().receive('junk');
  });
});

test('a host ERROR without reqId and without a pending hello goes to global error listeners', () => {
  const { client, current } = harness();
  const errors = [];
  client.onGlobalError((m) => errors.push(m));
  client.connect();
  current().receive({ type: RES.ERROR, reqId: null, code: ERR.INTERNAL, message: 'x' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'x');
});

test('default request ids are r + 32 hex characters and match the host pattern', () => {
  const ports = [];
  const client = new NativeClient({ connectNative: () => (ports.push(new FakePort()), ports.at(-1)) });
  const run = client.run('p', {}, () => {});
  assert.match(run.reqId, /^r[0-9a-f]{32}$/);
  assert.equal(ports[0].sent[0].reqId, run.reqId);
});

test('without an injected connectNative the client reports a disconnect instead of throwing', async () => {
  const client = new NativeClient({ timeoutMs: 1000 });
  await assert.rejects(client.hello(), /runtime|chrome|Cannot read/i);
});
