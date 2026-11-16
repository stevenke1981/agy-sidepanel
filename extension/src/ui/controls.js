// Header select helpers. modelOptions is pure; fillSelect touches the DOM via textContent only.

export const DEFAULT_MODEL_OPTION = Object.freeze({ value: '', label: 'default' });

/**
 * Options for the model select: "default" first, then host models. A saved model that the host
 * no longer lists is kept so the selection never silently changes.
 * @param {Array<{id: string, label?: string}>} models
 * @param {string} current saved model id ('' = default)
 * @returns {Array<{value: string, label: string}>}
 */
export function modelOptions(models, current) {
  const listed = (Array.isArray(models) ? models : [])
    .filter((m) => m && typeof m.id === 'string' && m.id !== '')
    .map((m) => ({ value: m.id, label: m.label || m.id }));
  const options = [DEFAULT_MODEL_OPTION, ...listed];
  if (current && !listed.some((m) => m.value === current)) {
    options.push({ value: current, label: `${current} (saved)` });
  }
  return options;
}

/**
 * @param {Document} doc
 * @param {HTMLSelectElement} select
 * @param {Array<{value: string, label: string}>} options
 * @param {string} selected
 */
export function fillSelect(doc, select, options, selected) {
  const nodes = options.map(({ value, label }) => {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  });
  select.replaceChildren(...nodes);
  select.value = selected ?? '';
}
