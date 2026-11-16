// UI-originated transcript rows (start-of-run notices, disconnects, failed starts). They go through the
// reducer's appendNote so they share the host row format (id, kind, reqId:null, length cap).
import { appendNote } from '../lib/transcript.js';

/**
 * @param {object} state TranscriptState
 * @param {string} text
 * @param {'note'|'error'} [kind]
 * @returns {object} new TranscriptState with the note row appended
 */
export function appendLocalNote(state, text, kind = 'note') {
  return appendNote(state, text, kind);
}
