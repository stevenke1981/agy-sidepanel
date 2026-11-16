// chrome.storage wrappers. chrome.* is only touched inside the functions, never at import time.
import { DEFAULT_SETTINGS } from './protocol.js';

const SETTINGS_KEY = 'settings';
const SKIP_PERMISSIONS_KEY = 'skipPermissions';

/** @typedef {typeof DEFAULT_SETTINGS} Settings */

/**
 * Keep only known keys whose value type matches the default. Unknown or malformed stored values are dropped.
 * @param {unknown} partial
 * @returns {Settings}
 */
export function mergeSettings(partial) {
  const source = partial && typeof partial === 'object' ? partial : {};
  const picked = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = source[key];
    if (value !== undefined && typeof value === typeof DEFAULT_SETTINGS[key]) picked[key] = value;
  }
  return { ...DEFAULT_SETTINGS, ...picked };
}

/** @returns {Promise<Settings>} */
export async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(stored[SETTINGS_KEY]);
}

/**
 * Merge a partial update onto the stored settings and persist the result.
 * @param {Partial<Settings>} partial
 * @returns {Promise<Settings>}
 */
export function saveSettings(partial) {
  // Serialize read-merge-write so rapid successive changes cannot overwrite each other (lost update).
  const run = saveQueue.then(async () => {
    const current = await loadSettings();
    const next = mergeSettings({ ...current, ...partial });
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  });
  saveQueue = run.catch(() => undefined);
  return run;
}

/** Tail of the pending save chain (module-local; never rejects). */
let saveQueue = Promise.resolve();

/**
 * skipPermissions lives in chrome.storage.session: it is cleared when the browser closes.
 * @returns {Promise<boolean>}
 */
export async function getSkipPermissions() {
  const stored = await chrome.storage.session.get(SKIP_PERMISSIONS_KEY);
  return stored[SKIP_PERMISSIONS_KEY] === true;
}

/** @param {boolean} enabled @returns {Promise<void>} */
export async function setSkipPermissions(enabled) {
  await chrome.storage.session.set({ [SKIP_PERMISSIONS_KEY]: enabled === true });
}

/** @param {number} windowId @returns {string} */
export function chatKey(windowId) {
  return `chat:${windowId}`;
}

/**
 * Load the saved chat for a window.
 * @param {number} windowId
 * @returns {Promise<object|null>} a TranscriptState, or null when none is saved
 */
export async function loadChat(windowId) {
  const key = chatKey(windowId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] ?? null;
}

/**
 * @param {number} windowId
 * @param {object} state TranscriptState (must be JSON-serializable)
 * @returns {Promise<void>}
 */
export async function saveChat(windowId, state) {
  await chrome.storage.session.set({ [chatKey(windowId)]: state });
}

/** @param {number} windowId @returns {Promise<void>} */
export async function clearChat(windowId) {
  await chrome.storage.session.remove(chatKey(windowId));
}
