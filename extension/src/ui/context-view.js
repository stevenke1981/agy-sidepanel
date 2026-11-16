// Page-context preview model: maps a getActiveTabContext() result to what the composer shows.
import { formatContextChip } from './view-format.js';

/** User-facing note per failure reason; shared by the preview and the send path. */
export const REASON_NOTE = Object.freeze({
  'no-permission': 'This site is not shared with agy Bridge yet.',
  'restricted-page': 'Browser pages cannot be read.',
  'no-tab': 'No active tab to read.',
  error: 'Could not read this page.'
});

/**
 * @param {object} input
 * @param {boolean} input.include  "Include page" toggle is on
 * @param {boolean} input.dropped  user removed context for this message only
 * @param {object|null} input.result  last getActiveTabContext() result, or null while reading
 * @param {object|null} input.summary summarizeContext(result.context) when result.ok
 * @returns {{mode: string, chip: object|null, note: string, origin: string|null}}
 */
export function contextViewFor({ include, dropped, result, summary }) {
  const base = { mode: 'off', chip: null, note: '', origin: null };
  if (!include) return base;
  if (dropped) return { ...base, mode: 'dropped', note: 'Page context removed for this message only.' };
  if (!result) return { ...base, mode: 'checking', note: 'Reading page…' };
  if (result.ok) return { ...base, mode: 'chip', chip: formatContextChip(summary) };
  if (result.reason === 'no-permission') {
    return { ...base, mode: 'no-permission', note: REASON_NOTE['no-permission'], origin: result.origin ?? null };
  }
  const note = REASON_NOTE[result.reason] ?? REASON_NOTE.error;
  return { ...base, mode: result.reason === 'restricted-page' ? 'restricted' : 'unavailable', note };
}
