// Pure send-path decisions: page-context gating, RunOptions assembly, composer key handling.
import { REASON_NOTE } from './context-view.js';

const GATED_NOTICE = 'Page context is only sent in plan mode without skip-permissions; sent without it.';

/**
 * Decide whether page context may be used. Gated modes never fail the send; they send without context.
 * @returns {{use: boolean, notice: string}}
 */
export function decidePageContext({ wantPage, skipPermissions, mode }) {
  if (!wantPage) return { use: false, notice: '' };
  if (skipPermissions === true || (mode || 'plan') !== 'plan') return { use: false, notice: GATED_NOTICE };
  return { use: true, notice: '' };
}

/** Note shown when page context was wanted but could not be read. */
export function unavailableNotice(reason) {
  return `${REASON_NOTE[reason] ?? REASON_NOTE.error} Sent without page context.`;
}

/**
 * RunOptions for host RUN (validated by protocol.validateRunOptions in tests).
 * Empty strings are accepted by the host and mean "agy default".
 */
export function buildRunOptions({ settings, skipPermissions, hasPageContext, conversationId }) {
  return {
    model: settings.model || '',
    effort: settings.effort || '',
    mode: settings.mode || 'plan',
    cwd: settings.cwd || '',
    conversationId: conversationId || '',
    skipPermissions: skipPermissions === true,
    hasPageContext: hasPageContext === true
  };
}

/** Enter sends; Shift+Enter, IME composition and Alt+Enter keep their default behaviour. */
export function shouldSendOnKey(event) {
  return event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing;
}

/** Quote every line of a selection as a Markdown blockquote. */
export function quoteSelection(selection) {
  return String(selection)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}

/** Button label and accessible name for the send/stop toggle. */
export function sendButtonView(busy) {
  return busy
    ? { label: 'Stop', ariaLabel: 'Stop response', stop: true }
    : { label: 'Send', ariaLabel: 'Send message', stop: false };
}
