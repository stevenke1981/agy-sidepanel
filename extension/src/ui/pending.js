// pendingPrompt (chrome.storage.session) handling: normalize the stored value and derive composer updates.
import { quoteSelection } from './send-plan.js';

/**
 * Accepts {kind:'selection', selection} or {kind:'page'} (also `type` / `text` aliases).
 * @returns {{kind: 'selection', selection: string}|{kind: 'page'}|null}
 */
export function parsePendingPrompt(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind ?? raw.type;
  if (kind === 'page') return { kind: 'page' };
  if (kind !== 'selection') return null;
  const selection = raw.selection ?? raw.text;
  return typeof selection === 'string' && selection.trim() !== '' ? { kind: 'selection', selection } : null;
}

/**
 * Composer update for a pending prompt. Both kinds switch "Include page" on and ask for a refresh.
 * @returns {{text: string, includePage: boolean}}
 */
export function composeFromPending(pending, currentText) {
  if (pending.kind === 'page') return { text: currentText, includePage: true };
  const quoted = quoteSelection(pending.selection);
  const text = [quoted, currentText].filter((part) => part !== '').join('\n\n');
  return { text, includePage: true };
}
