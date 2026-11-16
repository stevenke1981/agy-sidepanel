// Collapsible tool-step row. Step messages update in place (ACTIVE -> DONE, same id), so the
// caller re-renders the whole row from the latest message object. textContent only.
import { el } from './dom.js';
import { formatDuration } from './view-format.js';

/** Normalised step state: 'active' while running, 'done' once finished. */
export function stepStateOf(msg) {
  return String(msg.state ?? '').toUpperCase() === 'ACTIVE' ? 'active' : 'done';
}

/** Name shown in the summary: the agy tool name, else the step type, else a generic label. */
export function stepTitle(msg) {
  return msg.toolName || msg.stepType || 'step';
}

function buildGlyph(doc, state) {
  const glyph = el(doc, 'span', state === 'active' ? 'step-glyph step-spinner' : 'step-glyph step-check');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = state === 'active' ? '' : '✓';
  return glyph;
}

function buildSummary(doc, msg, state) {
  const summary = el(doc, 'summary', 'step-summary');
  summary.appendChild(buildGlyph(doc, state));
  summary.appendChild(el(doc, 'span', 'step-name', stepTitle(msg)));
  summary.appendChild(el(doc, 'span', 'step-state-text', state === 'active' ? 'running' : 'done'));
  const duration = formatDuration(msg.durationSeconds);
  if (duration) summary.appendChild(el(doc, 'span', 'step-dur', duration));
  return summary;
}

/** agy reports only tool arguments (toolInfo) for a step; it has no separate tool output to show. */
function buildDetail(doc, msg) {
  const body = el(doc, 'div', 'step-body');
  if (msg.toolInfo) body.appendChild(el(doc, 'pre', 'step-info', msg.toolInfo));
  else body.appendChild(el(doc, 'span', 'step-empty', 'No details.'));
  return body;
}

/**
 * @param {Document} doc
 * @param {object} msg transcript message with role 'step'
 * @returns {HTMLElement}
 */
export function buildStepRow(doc, msg) {
  const state = stepStateOf(msg);
  const details = el(doc, 'details', 'step');
  details.setAttribute('data-state', state);
  details.appendChild(buildSummary(doc, msg, state));
  details.appendChild(buildDetail(doc, msg));
  return details;
}
