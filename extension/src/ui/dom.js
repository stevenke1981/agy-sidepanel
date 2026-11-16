// Small DOM helpers. Every helper takes a `doc` so views can be tested with a fake document.
// Dynamic content goes through textContent / text nodes only; no innerHTML anywhere.

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text] set via textContent
 * @returns {HTMLElement}
 */
export function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/**
 * Map of element id to element (null when missing), for a fixed list of ids.
 * @param {Document} doc
 * @param {string[]} ids
 * @returns {Record<string, HTMLElement|null>}
 */
export function collectById(doc, ids) {
  return Object.fromEntries(ids.map((id) => [id, doc.getElementById(id)]));
}

/**
 * Context chip: title, host and character count for a page context summary.
 * @param {Document} doc
 * @param {{title: string, host: string, chars: string}} chip from formatContextChip()
 * @returns {HTMLElement}
 */
export function buildContextChip(doc, chip) {
  const node = el(doc, 'span', 'context-chip');
  node.appendChild(el(doc, 'span', 'chip-title', chip.title));
  if (chip.host) node.appendChild(el(doc, 'span', 'chip-host', chip.host));
  node.appendChild(el(doc, 'span', 'chip-chars', chip.chars));
  return node;
}
