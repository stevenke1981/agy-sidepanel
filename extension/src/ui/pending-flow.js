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
  let rerun = false;
  let inFlight = null;

  async function takeOnce() {
    try {
      const stored = await chrome.storage.session.get(PENDING_KEY);
      if (!stored[PENDING_KEY]) return;
      await chrome.storage.session.remove(PENDING_KEY);
      const pending = parsePendingPrompt(stored[PENDING_KEY]);
      if (pending) await applyPrefill(composeFromPending(pending, prompt.value));
    } catch (error) {
      notify(`Could not read pending prompt: ${errorText(error)}`);
    }
  }

  /**
   * A call while busy sets `rerun` instead of being dropped: a pending prompt written during the current pass
   * is picked up by one more pass. The loop check and `busy = false` run in the same synchronous step, so no
   * call can land between "no rerun requested" and "idle".
   * Callers get the in-flight promise, so awaiting consume() waits for every pass.
   */
  function consume() {
    if (busy) {
      rerun = true;
      return inFlight;
    }
    busy = true;
    inFlight = (async () => {
      try {
        do {
          rerun = false;
          await takeOnce();
        } while (rerun);
      } finally {
        busy = false;
      }
    })();
    return inFlight;
  }

  return { consume };
}
