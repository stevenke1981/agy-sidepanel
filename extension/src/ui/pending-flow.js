// Consumes the pendingPrompt hand-off written by the context menu (chrome.storage.session).
// Read, clear, then apply: the key is removed before the composer changes so it is never applied twice.
import { composeFromPending, parsePendingPrompt } from './pending.js';
import { errorText } from './view-format.js';

export const PENDING_KEY = 'pendingPrompt';

/**
 * @param {object} deps
 * @param {HTMLTextAreaElement} deps.prompt        composer; its current text is read at apply time
 * @param {(next: {text: string, includePage: boolean}) => Promise<void>} deps.applyPrefill
 * @param {(text: string) => void} deps.notify
 * @returns {{consume: () => Promise<void>}}
 */
export function createPendingFlow({ prompt, applyPrefill, notify }) {
  let busy = false;

  async function consume() {
    if (busy) return;
    busy = true;
    try {
      const stored = await chrome.storage.session.get(PENDING_KEY);
      if (!stored[PENDING_KEY]) return;
      await chrome.storage.session.remove(PENDING_KEY);
      const pending = parsePendingPrompt(stored[PENDING_KEY]);
      if (pending) await applyPrefill(composeFromPending(pending, prompt.value));
    } catch (error) {
      notify(`Could not read pending prompt: ${errorText(error)}`);
    } finally {
      busy = false;
    }
  }

  return { consume };
}
