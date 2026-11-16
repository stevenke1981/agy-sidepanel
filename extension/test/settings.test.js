import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome.storage.local fake whose get/set yield, so concurrent saves would interleave.
function installFakeChrome() {
  const store = {};
  const tick = () => new Promise((r) => setTimeout(r, 1));
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) { await tick(); return key in store ? { [key]: structuredClone(store[key]) } : {}; },
        async set(obj) { await tick(); Object.assign(store, structuredClone(obj)); }
      }
    }
  };
  return store;
}

test('rapid successive saveSettings calls do not lose updates', async () => {
  installFakeChrome();
  const { saveSettings, loadSettings } = await import('../src/lib/settings.js');
  await Promise.all([
    saveSettings({ model: 'gemini-3.8-flash-low' }),
    saveSettings({ includePageContext: false }),
    saveSettings({ mode: 'accept-edits' })
  ]);
  const s = await loadSettings();
  assert.equal(s.model, 'gemini-3.8-flash-low');
  assert.equal(s.includePageContext, false);
  assert.equal(s.mode, 'accept-edits');
});
