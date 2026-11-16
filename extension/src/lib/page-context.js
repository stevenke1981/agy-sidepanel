// Active-tab page capture via chrome.scripting. chrome.* is only touched inside the async functions.
import { normalizeBudget } from './prompt.js';

const RESTRICTED_PROTOCOLS = new Set([
  'chrome:', 'chrome-extension:', 'chrome-search:', 'chrome-untrusted:', 'edge:', 'about:', 'devtools:', 'view-source:',
]);
const WEBSTORE_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com']);

/**
 * @typedef {{title: string, url: string, selection: string, text: string}} CapturedContext
 * @typedef {{ok: true, context: CapturedContext, tabId: number}
 *   | {ok: false, reason: 'no-permission'|'restricted-page'|'no-tab'|'error', origin?: string, message?: string}} TabContextResult
 */

/** @param {unknown} err @returns {string} */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/** @param {string} url @returns {URL|null} */
function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Decide whether a tab URL may be captured. Returns the origin when access must be granted per site.
 * file:// is always restricted here: file URL access is a separate Chrome setting, not an origin grant.
 * @param {string|undefined} url
 * @returns {{ok: true, origin: string} | {ok: false, reason: 'no-permission'|'restricted-page'}}
 */
export function classifyUrl(url) {
  // Chrome hides tab.url until the origin is granted or activeTab applies, so a missing URL means "ask first".
  if (typeof url !== 'string') return { ok: false, reason: 'no-permission' };
  const parsed = parseUrl(url);
  if (!parsed) return { ok: false, reason: 'restricted-page' };
  if (RESTRICTED_PROTOCOLS.has(parsed.protocol)) return { ok: false, reason: 'restricted-page' };
  if (WEBSTORE_HOSTS.has(parsed.hostname)) return { ok: false, reason: 'restricted-page' };
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'restricted-page' };
  return { ok: true, origin: parsed.origin };
}

/**
 * Permission pattern for one origin, e.g. "https://example.com/*". Null for anything that is not a bare http(s) origin.
 * @param {string} origin
 * @returns {string|null}
 */
export function originPattern(origin) {
  const parsed = parseUrl(origin);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
  if (parsed.origin !== origin) return null;
  return `${parsed.origin}/*`;
}

/**
 * Runs inside the page via chrome.scripting. Must stay self-contained (it is serialized).
 * @param {number} maxChars
 * @returns {CapturedContext}
 */
function extractPageContent(maxChars) {
  const selection = String(window.getSelection?.()?.toString() ?? '').trim();
  const root = document.body ?? document.documentElement;
  const text = String(root?.innerText ?? root?.textContent ?? '');
  return {
    title: String(document.title ?? ''),
    url: String(location.href),
    selection: selection.slice(0, maxChars),
    text: text.slice(0, maxChars),
  };
}

/**
 * @param {number} tabId
 * @param {number} maxChars
 * @returns {Promise<TabContextResult>}
 */
async function extractFromTab(tabId, maxChars) {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, func: extractPageContent, args: [maxChars],
  });
  const value = results?.[0]?.result;
  if (!value || typeof value !== 'object') return { ok: false, reason: 'error' };
  return { ok: true, tabId, context: value };
}

/**
 * Capture the focused tab (lastFocusedWindow) for the side panel.
 * @param {{maxChars?: number}} [options]
 * @returns {Promise<TabContextResult>}
 */
export async function getActiveTabContext({ maxChars } = {}) {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (!tab || typeof tab.id !== 'number') return { ok: false, reason: 'no-tab' };
    // No visible URL: neither activeTab nor a host grant applies. '*' asks for all sites.
    if (typeof tab.url !== 'string') return { ok: false, reason: 'no-permission', origin: ALL_SITES };
    const access = classifyUrl(tab.url);
    if (!access.ok) return access;
    // Try directly: activeTab grants work without appearing in permissions.contains().
    const result = await extractFromTab(tab.id, normalizeBudget(maxChars)).catch((err) => ({
      ok: false, reason: 'no-permission', origin: access.origin, message: messageOf(err)
    }));
    return result.ok || result.reason !== 'error' ? result : { ...result, reason: 'no-permission', origin: access.origin };
  } catch (err) {
    return { ok: false, reason: 'error', message: messageOf(err) };
  }
}

/** Sentinel origin meaning "request access to all sites" (manifest optional_host_permissions). */
export const ALL_SITES = '*';

/**
 * Ask for host access to one origin. Must run inside a user gesture (e.g. a button click in the side panel).
 * @param {string} origin
 * @returns {Promise<{granted: boolean, error: string|null}>}
 */
export async function requestSiteAccess(origin) {
  const pattern = origin === ALL_SITES ? '<all_urls>' : originPattern(origin);
  if (!pattern) return { granted: false, error: 'invalid origin' };
  try {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    return { granted: granted === true, error: null };
  } catch (err) {
    return { granted: false, error: messageOf(err) };
  }
}
