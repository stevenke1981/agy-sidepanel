// DOM updates for header, status line, send button and composer context area.
// Each function receives the element map (`el`) and plain data; no module state lives here.
import { fillSelect, modelOptions } from './controls.js';
import { contextViewFor } from './context-view.js';
import { formatSessionBadge, formatUsage } from './view-format.js';
import { sendButtonView } from './send-plan.js';
import { summarizeContext } from '../lib/prompt.js';

export function renderSessionBadge(el, state) {
  const text = formatSessionBadge(state);
  el['session-badge'].textContent = text;
  el['session-badge'].hidden = text === '';
}

export function renderUsage(el, state) {
  const failed = state.status === 'ERROR';
  const parts = [];
  if (failed) parts.push('run failed');
  if (failed && typeof state.error === 'string') parts.push(state.error);
  const usage = formatUsage(state.usage);
  if (usage) parts.push(usage);
  el.usage.textContent = parts.join(' · ');
  el.usage.setAttribute('data-status', failed ? 'error' : 'ok');
  el.usage.hidden = parts.length === 0;
}

export function renderSendButton(el, busy) {
  const view = sendButtonView(busy);
  el['btn-send'].textContent = view.label;
  el['btn-send'].setAttribute('aria-label', view.ariaLabel);
  el['btn-send'].classList.toggle('is-stop', view.stop);
}

/**
 * @param {Document} doc
 * @param {object} el element map
 * @param {{models: Array, settings: object}} data
 */
export function renderModelSelect(doc, el, { models, settings }) {
  fillSelect(doc, el['model-select'], modelOptions(models, settings.model), settings.model);
}

/** Header controls that mirror saved settings: model, mode, include toggle, skip banner. */
export function renderControls(doc, el, { models, settings, skipPermissions }) {
  renderModelSelect(doc, el, { models, settings });
  el['mode-select'].value = settings.mode;
  el['btn-include'].setAttribute('aria-pressed', String(settings.includePageContext));
  el['skip-banner'].hidden = !skipPermissions;
}

/**
 * @param {object} el element map
 * @param {{include: boolean, dropped: boolean, preview: object|null}} data
 */
export function renderContextView(el, { include, dropped, preview }) {
  const view = contextViewFor({
    include,
    dropped,
    result: preview,
    summary: preview?.ok ? summarizeContext(preview.context) : null
  });
  el['chip-wrap'].hidden = view.mode !== 'chip';
  if (view.chip) {
    el['chip-title'].textContent = view.chip.title;
    el['chip-host'].textContent = view.chip.host;
    el['chip-chars'].textContent = view.chip.chars;
  }
  el['context-note'].textContent = view.note;
  el['context-note'].hidden = view.note === '';
  el['btn-allow'].hidden = !(view.mode === 'no-permission' && view.origin);
}

export function autosize(textarea, maxPx) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxPx)}px`;
}
