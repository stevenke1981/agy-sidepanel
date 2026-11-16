// UI-originated transcript rows (notes, errors) that do not come from the host.
// Returns new state objects; the transcript state itself is never mutated.

let localCounter = 0;

/** Unique-enough id for UI-only rows; never collides with host-derived ids. */
export function makeLocalId(now = Date.now()) {
  localCounter += 1;
  return `local-${now.toString(36)}-${localCounter}`;
}

/**
 * @param {string} id
 * @param {'note'|'error'} role
 * @param {string} text
 */
export function makeLocalMessage(id, role, text) {
  return { id, role, text: String(text), reqId: null };
}

/** @returns {object} new state with the message appended */
export function appendLocalMessage(state, message) {
  return { ...state, messages: [...state.messages, message] };
}
