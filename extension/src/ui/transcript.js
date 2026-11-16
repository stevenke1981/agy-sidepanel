// Transcript rendering. Messages are immutable, so each message object maps to one DOM node;
// unchanged messages (and open <details> rows) are reused across renders.
import { buildContextChip, el } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { buildStepRow } from './step-row.js';
import { formatContextChip } from './view-format.js';

function buildUser(doc, msg) {
  const article = el(doc, 'article', 'msg msg-user');
  article.setAttribute('aria-label', 'You');
  article.appendChild(el(doc, 'span', 'msg-label', 'you'));
  article.appendChild(el(doc, 'div', 'bubble', msg.text));
  const chip = formatContextChip(msg.contextSummary);
  if (chip) article.appendChild(buildContextChip(doc, chip));
  return article;
}

function buildAssistant(doc, msg) {
  const article = el(doc, 'article', 'msg msg-assistant');
  article.setAttribute('aria-label', 'agy');
  article.appendChild(el(doc, 'span', 'msg-label', 'agy'));
  const body = el(doc, 'div', 'md');
  body.appendChild(renderMarkdown(doc, msg.text ?? ''));
  article.appendChild(body);
  return article;
}

function buildNote(doc, msg, isError) {
  const note = el(doc, 'div', isError ? 'note note-error' : 'note', msg.text);
  note.setAttribute('role', isError ? 'alert' : 'note');
  return note;
}

/** Dispatch on role. Unknown roles render as generic notes so unknown host events stay visible. */
export function buildMessage(doc, msg) {
  if (msg.role === 'user') return buildUser(doc, msg);
  if (msg.role === 'assistant') return buildAssistant(doc, msg);
  if (msg.role === 'step') return buildStepRow(doc, msg);
  return buildNote(doc, msg, msg.role === 'error');
}

function buildEmpty(doc) {
  const empty = el(doc, 'div', 'empty');
  empty.appendChild(el(doc, 'p', 'empty-title', 'Ask agy anything.'));
  empty.appendChild(el(doc, 'p', 'muted', 'Include the page you are reading, or right-click a selection and choose “Ask agy about selection”.'));
  return empty;
}

function buildWorking(doc) {
  const row = el(doc, 'div', 'working');
  row.setAttribute('role', 'status');
  const dots = el(doc, 'span', 'typing');
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) dots.appendChild(el(doc, 'span', 'typing-dot'));
  row.appendChild(dots);
  row.appendChild(el(doc, 'span', 'sr-only', 'agy is working'));
  return row;
}

/**
 * @param {Document} doc
 * @returns {{render: (container: HTMLElement, messages: object[], options: {busy: boolean}) => void}}
 */
export function createTranscriptRenderer(doc) {
  const cache = new WeakMap();
  const nodeFor = (msg) => {
    const cached = cache.get(msg);
    if (cached) return cached;
    const node = buildMessage(doc, msg);
    cache.set(msg, node);
    return node;
  };
  return {
    render(container, messages, { busy }) {
      const nodes = messages.length === 0 ? [buildEmpty(doc)] : messages.map(nodeFor);
      if (busy) nodes.push(buildWorking(doc));
      container.replaceChildren(...nodes);
    }
  };
}
