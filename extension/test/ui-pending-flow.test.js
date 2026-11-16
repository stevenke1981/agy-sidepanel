import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPendingFlow, PENDING_KEY } from '../src/ui/pending-flow.js';

/** Install an in-memory chrome.storage.session. get() snapshots the value when it is called. */
function installSessionStorage(initial = {}) {
  const store = { ...initial };
  globalThis.chrome = {
    storage: {
      session: {
        async get(key) {
          return { [key]: store[key] };
        },
        async remove(key) {
          delete store[key];
        }
      }
    }
  };
  return store;
}

afterEach(() => {
  delete globalThis.chrome;
});

test('a pending prompt that arrives while a pass is applying is picked up by a rerun, not dropped', async () => {
  const store = installSessionStorage({ [PENDING_KEY]: { kind: 'selection', selection: 'alpha' } });
  const applied = [];
  let flow;
  flow = createPendingFlow({
    prompt: { value: '' },
    notify: () => {},
    applyPrefill: async (next) => {
      applied.push(next.text);
      if (applied.length === 1) {
        // storage.onChanged for a second context-menu click, while the first pass is still applying.
        store[PENDING_KEY] = { kind: 'selection', selection: 'beta' };
        flow.consume();
      }
    }
  });
  await flow.consume();
  assert.deepEqual(applied, ['> alpha', '> beta']);
  assert.equal(PENDING_KEY in store, false);
});

test('concurrent calls with a single pending prompt apply it exactly once', async () => {
  installSessionStorage({ [PENDING_KEY]: { kind: 'selection', selection: 'once' } });
  const applied = [];
  const flow = createPendingFlow({
    prompt: { value: '' },
    notify: () => {},
    applyPrefill: async (next) => applied.push(next.text)
  });
  await Promise.all([flow.consume(), flow.consume(), flow.consume()]);
  assert.deepEqual(applied, ['> once']);
});

test('a storage read failure is reported through notify and does not wedge later passes', async () => {
  const store = installSessionStorage();
  let fail = true;
  const notices = [];
  const applied = [];
  globalThis.chrome.storage.session.get = async (key) => {
    if (fail) throw new Error('storage offline');
    return { [key]: store[key] };
  };
  const flow = createPendingFlow({
    prompt: { value: '' },
    notify: (text) => notices.push(text),
    applyPrefill: async (next) => applied.push(next.text)
  });
  await flow.consume();
  assert.deepEqual(notices, ['Could not read pending prompt: storage offline']);

  fail = false;
  store[PENDING_KEY] = { kind: 'selection', selection: 'later' };
  await flow.consume();
  assert.deepEqual(applied, ['> later']);
});
