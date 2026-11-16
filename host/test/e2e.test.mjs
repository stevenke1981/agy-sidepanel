// Real integration test: runs host/src/bridge.mjs as a child process against the installed agy CLI.
// Skipped unless AGY_BRIDGE_E2E=1 (it calls the real model service).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDecoder, encodeMessage } from '../src/framing.mjs';
import { PROTOCOL_VERSION } from '../../extension/src/lib/protocol.js';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bridge.mjs');
const RUN_ID = 'e2e-run-1';
const TIMEOUT_MS = 240_000;
const enabled = process.env.AGY_BRIDGE_E2E === '1';

function startHost() {
  const child = spawn(process.execPath, [BRIDGE], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const frames = [];
  const waiters = [];
  const notify = () => {
    for (const waiter of [...waiters]) {
      if (waiter.test(frames)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  const decoder = createDecoder((msg) => {
    frames.push(msg);
    notify();
  }, (error) => frames.push({ type: 'decode-error', message: error.message }));
  child.stdout.on('data', (chunk) => decoder.push(chunk));
  const waitFor = (test) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for host frame')), TIMEOUT_MS);
    waiters.push({ test, resolve: () => { clearTimeout(timer); resolve(); } });
    notify();
  });
  return { child, frames, waitFor };
}

test('real agy round trip: HELLO then RUN returns pong and EXIT code 0', { skip: !enabled && 'set AGY_BRIDGE_E2E=1 to run', timeout: TIMEOUT_MS + 10_000 }, async () => {
  const host = startHost();
  try {
    host.child.stdin.write(encodeMessage({ type: 'hello', protocol: PROTOCOL_VERSION }));
    await host.waitFor((frames) => frames.some((m) => m.type === 'hello'));
    const hello = host.frames.find((m) => m.type === 'hello');
    assert.ok(hello.agyPath, 'agy path must be resolved');

    host.child.stdin.write(encodeMessage({
      type: 'run',
      reqId: RUN_ID,
      prompt: 'Reply with exactly: pong',
      options: { model: 'gemini-3.8-flash-low' },
    }));
    await host.waitFor((frames) => frames.some((m) => m.type === 'exit' && m.reqId === RUN_ID));
    const exit = host.frames.find((m) => m.type === 'exit' && m.reqId === RUN_ID);
    assert.equal(exit.code, 0, JSON.stringify(exit));
    assert.equal(exit.cancelled, false);

    const texts = host.frames
      .filter((m) => m.type === 'event' && m.reqId === RUN_ID)
      .map((m) => m.event?.step_update?.text_delta ?? m.event?.result?.response ?? '')
      .join('');
    assert.match(texts, /pong/i);
    assert.equal(host.frames.filter((m) => m.type === 'exit' && m.reqId === RUN_ID).length, 1);
  } finally {
    const exited = new Promise((resolve) => host.child.once('exit', resolve));
    host.child.stdin.end();
    if (host.child.exitCode === null && host.child.signalCode === null) await exited;
  }
});
