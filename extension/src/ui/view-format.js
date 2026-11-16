// Pure formatting helpers for the side panel (no DOM, no chrome.* access).

const UNTITLED = 'Untitled page';

/** Thousands separators, deterministic across locales. */
export function formatCount(value) {
  const n = Number.isFinite(value) ? Math.trunc(value) : 0;
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "in 1,234 · out 56 · total 1,290" or '' when usage is absent. */
export function formatUsage(usage) {
  if (!usage || typeof usage !== 'object') return '';
  return [
    `in ${formatCount(usage.input_tokens)}`,
    `out ${formatCount(usage.output_tokens)}`,
    `total ${formatCount(usage.total_tokens)}`
  ].join(' · ');
}

/** "claude-x · plan · 12 tools" from session init fields; empty parts are dropped. */
export function formatSessionBadge({ model, permissionMode, toolsCount } = {}) {
  const tools = Number.isFinite(toolsCount) && toolsCount > 0 ? `${toolsCount} tools` : '';
  return [model, permissionMode, tools].filter(Boolean).join(' · ');
}

/** Seconds to "0.4s" or "2m 5s"; '' for non-numbers. */
export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** Host (with port) of a URL, or '' when it does not parse. */
export function formatHost(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return '';
  }
}

/**
 * @param {{title?: string, url?: string, chars?: number}|null} summary from summarizeContext()
 * @returns {{title: string, host: string, chars: string}|null}
 */
export function formatContextChip(summary) {
  if (!summary) return null;
  return {
    title: summary.title || UNTITLED,
    host: formatHost(summary.url),
    chars: `${formatCount(summary.chars)} chars`
  };
}

/** Connection view for a HELLO reply. */
export function formatConnection(hello) {
  const version = hello?.agyVersion ? ` · agy v${hello.agyVersion}` : '';
  return { state: 'connected', text: `connected${version}` };
}

export function connectingView() {
  return { state: 'connecting', text: 'connecting…' };
}

export function missingView() {
  return { state: 'missing', text: 'host not installed' };
}

/** Human-readable text from an Error, a string, or anything else. Never empty. */
export function errorText(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error;
  return 'Unknown error';
}
