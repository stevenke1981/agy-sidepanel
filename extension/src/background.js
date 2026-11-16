// MV3 service worker: side panel behavior, context menus, and hand-off of a pending prompt to the side panel.
import { LIMITS } from './lib/protocol.js';

const PENDING_KEY = 'pendingPrompt';
const BG_ERROR_KEY = 'bgError';
const MENU_SELECTION = 'agy-ask-selection';
const MENU_PAGE = 'agy-send-page';

/** @typedef {'selection'|'page'} PromptKind */

/**
 * @param {string} menuItemId
 * @returns {PromptKind|null}
 */
function kindForMenu(menuItemId) {
  if (menuItemId === MENU_SELECTION) return 'selection';
  if (menuItemId === MENU_PAGE) return 'page';
  return null;
}

/**
 * Record a background failure where the side panel can read it. Nothing else can report from a service worker.
 * @param {string} where
 * @param {unknown} err
 */
function recordError(where, err) {
  const message = err instanceof Error ? err.message : String(err);
  chrome.storage.session.set({ [BG_ERROR_KEY]: { where, message, ts: Date.now() } }).catch(() => {
    // Last resort: storage itself failed, so there is no further channel to report through.
  });
}

function createMenus() {
  chrome.contextMenus.create({
    id: MENU_SELECTION, title: 'Ask agy about selection', contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: MENU_PAGE, title: 'Send page to agy', contexts: ['page'],
  });
}

function setupOnInstall() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => recordError('setPanelBehavior', err));
  chrome.contextMenus.removeAll()
    .then(createMenus)
    .catch((err) => recordError('contextMenus', err));
}

/**
 * @param {PromptKind} kind
 * @param {chrome.contextMenus.OnClickData} info
 * @param {chrome.tabs.Tab} tab
 * @returns {{kind: PromptKind, text: string, tabId: number, ts: number}}
 */
function buildPending(kind, info, tab) {
  const selection = kind === 'selection' ? String(info.selectionText ?? '') : '';
  return {
    kind,
    text: selection.slice(0, LIMITS.MAX_PROMPT_CHARS),
    tabId: tab.id,
    ts: Date.now(),
  };
}

/**
 * @param {chrome.contextMenus.OnClickData} info
 * @param {chrome.tabs.Tab|undefined} tab
 */
function onMenuClicked(info, tab) {
  const kind = kindForMenu(info.menuItemId);
  if (!kind || typeof tab?.id !== 'number') return;
  // Keep this synchronous up to open(): the user gesture is only valid until the first await.
  chrome.sidePanel.open({ tabId: tab.id }).catch((err) => recordError('sidePanel.open', err));
  chrome.storage.session.set({ [PENDING_KEY]: buildPending(kind, info, tab) })
    .catch((err) => recordError('pendingPrompt', err));
}

chrome.runtime.onInstalled.addListener(setupOnInstall);
chrome.contextMenus.onClicked.addListener(onMenuClicked);
