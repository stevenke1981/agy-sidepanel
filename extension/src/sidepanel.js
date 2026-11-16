// Side panel orchestration: wires DOM events to the native client, transcript reducer and storage.
// Rendering lives in ui/*.js; decisions are in ui/send-plan.js, ui/context-view.js and ui/pending.js;
// the page-context flow is ui/page-flow.js and the context-menu hand-off is ui/pending-flow.js.
import { initialState, applyHostMessage, addUserMessage, startRun, newConversation } from './lib/transcript.js';
import { buildPrompt, makeNonce, summarizeContext } from './lib/prompt.js';
import { loadSettings, saveSettings, getSkipPermissions, loadChat, saveChat, clearChat } from './lib/settings.js';
import { createNativeClient } from './lib/native-client.js';
import { createTranscriptRenderer } from './ui/transcript.js';
import { collectById } from './ui/dom.js';
import { connectingView, errorText, formatConnection, missingView } from './ui/view-format.js';
import {
  autosize, renderContextView, renderControls, renderModelSelect, renderSendButton, renderSessionBadge,
  renderUsage
} from './ui/panel-render.js';
import { buildRunOptions, shouldSendOnKey } from './ui/send-plan.js';
import { appendLocalMessage, makeLocalId, makeLocalMessage } from './ui/local-messages.js';
import { createPageFlow } from './ui/page-flow.js';
import { createPendingFlow, PENDING_KEY } from './ui/pending-flow.js';

const SAVE_DEBOUNCE_MS = 300;
const STICK_THRESHOLD_PX = 48;
const TEXTAREA_MAX_PX = 160;
const TOAST_MS = 4000;
const ELEMENT_IDS = [
  'status-dot', 'status-text', 'btn-ide', 'btn-new', 'btn-settings', 'model-select', 'mode-select',
  'session-badge', 'skip-banner', 'onboarding', 'onboarding-error', 'btn-retry', 'transcript', 'btn-jump',
  'usage', 'toast', 'btn-include', 'chip-wrap', 'chip-title', 'chip-host', 'chip-chars', 'btn-drop',
  'context-note', 'btn-allow', 'prompt', 'btn-send'
];

const doc = document;
const el = collectById(doc, ELEMENT_IDS);
const app = {
  client: null,
  hello: null,
  models: [],
  settings: null,
  skipPermissions: false,
  state: null,
  windowId: null,
  activeRun: null,
  sending: false,
  gen: 0,
  preview: null,
  previewToken: 0,
  dropped: false,
  renderQueued: false,
  stick: true,
  saveTimer: 0,
  toastTimer: 0,
  renderer: null
};
const { refreshPreview, resolvePageContext, allowSite } = createPageFlow({
  app,
  render: () => refreshContextView(),
  notify: (text) => showToast(text)
});
const pendingFlow = createPendingFlow({
  prompt: el.prompt,
  applyPrefill: applyPrefill,
  notify: (text) => showToast(text)
});

// ---- Connection and onboarding -------------------------------------------

function setConnection(view) {
  el['status-dot'].setAttribute('data-state', view.state);
  el['status-text'].textContent = view.text;
}

function showOnboarding(message) {
  app.hello = null;
  setConnection(missingView());
  el['onboarding-error'].textContent = message;
  el.onboarding.hidden = false;
  el['btn-ide'].disabled = true;
}

async function connectHost() {
  setConnection(connectingView());
  el.onboarding.hidden = true;
  const client = createNativeClient();
  app.client = client;
  client.onDisconnect((message) => {
    if (client === app.client) handleDisconnect(message);
  });
  try {
    await client.connect();
    app.hello = await client.hello();
    setConnection(formatConnection(app.hello));
    el['btn-ide'].disabled = app.hello.ideAvailable !== true;
    await loadModels(client);
  } catch (error) {
    showOnboarding(errorText(error));
  }
}

function handleDisconnect(message) {
  const text = errorText(message);
  if (app.activeRun) {
    app.activeRun = null;
    appendNote('error', `Host disconnected: ${text}`);
  }
  showOnboarding(text);
}

async function loadModels(client) {
  try {
    app.models = await client.listModels();
  } catch (error) {
    showToast(`Model list unavailable: ${errorText(error)}`);
  }
  renderModelSelect(doc, el, { models: app.models, settings: app.settings });
}

// ---- Rendering ------------------------------------------------------------

function requestRender() {
  if (app.renderQueued) return;
  app.renderQueued = true;
  requestAnimationFrame(() => {
    app.renderQueued = false;
    renderNow();
  });
}

function renderNow() {
  const busy = app.activeRun !== null;
  app.renderer.render(el.transcript, app.state.messages, { busy });
  renderSessionBadge(el, app.state);
  renderUsage(el, app.state);
  renderSendButton(el, busy);
  if (app.stick) el.transcript.scrollTop = el.transcript.scrollHeight;
  el['btn-jump'].hidden = app.stick || app.state.messages.length === 0;
}

function refreshControls() {
  renderControls(doc, el, { models: app.models, settings: app.settings, skipPermissions: app.skipPermissions });
}

function refreshContextView() {
  renderContextView(el, { include: app.settings.includePageContext, dropped: app.dropped, preview: app.preview });
}

function showToast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, TOAST_MS);
}

// ---- Transcript state -----------------------------------------------------

function appendNote(role, text) {
  app.state = appendLocalMessage(app.state, makeLocalMessage(makeLocalId(), role, text));
  requestRender();
  scheduleSave();
}

function onHostMessage(msg) {
  app.state = applyHostMessage(app.state, msg);
  const finished = Boolean(msg) && (msg.type === 'exit' || msg.type === 'error');
  if (finished && app.activeRun && msg.reqId === app.activeRun.reqId) app.activeRun = null;
  requestRender();
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

function flushSave() {
  clearTimeout(app.saveTimer);
  app.saveTimer = 0;
  if (app.windowId === null || !app.state) return;
  saveChat(app.windowId, app.state).catch((error) => showToast(`Could not save chat: ${errorText(error)}`));
}

function onTranscriptScroll() {
  const t = el.transcript;
  app.stick = t.scrollHeight - t.scrollTop - t.clientHeight < STICK_THRESHOLD_PX;
  el['btn-jump'].hidden = app.stick;
}

function jumpToLatest() {
  app.stick = true;
  el.transcript.scrollTop = el.transcript.scrollHeight;
  el['btn-jump'].hidden = true;
}

// ---- Send and stop --------------------------------------------------------

async function sendMessage() {
  if (app.sending || app.activeRun) return;
  const text = el.prompt.value.trim();
  if (!text) return;
  if (!app.client || !app.hello) {
    showToast('Host is not connected. Press Retry.');
    return;
  }
  app.sending = true;
  try {
    await dispatchPrompt(text);
  } finally {
    app.sending = false;
  }
}

async function dispatchPrompt(text) {
  const page = await resolvePageContext();
  const options = buildRunOptions({
    settings: app.settings,
    skipPermissions: app.skipPermissions,
    hasPageContext: page.context !== null,
    conversationId: app.state.conversationId
  });
  const prompt = buildPrompt({
    userText: text,
    context: page.context,
    maxContextChars: app.settings.maxContextChars,
    nonce: makeNonce()
  });
  startHostRun({ prompt, options, text, page });
}

function startHostRun({ prompt, options, text, page }) {
  const gen = app.gen;
  let handle;
  try {
    handle = app.client.run(prompt, options, (msg) => {
      if (gen === app.gen) onHostMessage(msg);
    });
  } catch (error) {
    el.prompt.value = text;
    autosize(el.prompt, TEXTAREA_MAX_PX);
    appendNote('error', `Could not start run: ${errorText(error)}`);
    return;
  }
  app.activeRun = handle;
  const contextSummary = page.context ? summarizeContext(page.context) : null;
  let state = addUserMessage(app.state, text, contextSummary);
  for (const notice of page.notices) state = appendLocalMessage(state, makeLocalMessage(makeLocalId(), 'note', notice));
  app.state = startRun(state, handle.reqId);
  app.dropped = false;
  el.prompt.value = '';
  autosize(el.prompt, TEXTAREA_MAX_PX);
  refreshContextView();
  requestRender();
  scheduleSave();
}

function stopRun() {
  if (!app.activeRun) return;
  try {
    app.activeRun.cancel();
  } catch (error) {
    showToast(`Could not stop: ${errorText(error)}`);
  }
}

// ---- Chat lifecycle and settings -----------------------------------------

async function newChat() {
  clearTimeout(app.saveTimer);
  app.saveTimer = 0;
  app.gen += 1;
  stopRun();
  app.activeRun = null;
  app.state = newConversation();
  app.dropped = false;
  requestRender();
  try {
    await clearChat(app.windowId);
  } catch (error) {
    showToast(`Could not clear saved chat: ${errorText(error)}`);
  }
}

async function openIde() {
  const path = app.settings.cwd || app.hello?.defaultCwd || '';
  if (!path || !app.client) {
    showToast('No workspace folder is available.');
    return;
  }
  try {
    await app.client.openIde(path);
    showToast('Opening workspace in Antigravity IDE…');
  } catch (error) {
    showToast(`Could not open IDE: ${errorText(error)}`);
  }
}

async function updateSetting(partial) {
  app.settings = { ...app.settings, ...partial };
  refreshControls();
  try {
    await saveSettings(partial);
  } catch (error) {
    showToast(`Could not save setting: ${errorText(error)}`);
  }
}

async function toggleInclude() {
  app.dropped = false;
  await updateSetting({ includePageContext: !app.settings.includePageContext });
  await refreshPreview();
}

function dropForMessage() {
  app.dropped = true;
  refreshContextView();
}

async function reloadSettings() {
  app.settings = await loadSettings();
  refreshControls();
  await refreshPreview();
}

async function applyPrefill(next) {
  el.prompt.value = next.text;
  autosize(el.prompt, TEXTAREA_MAX_PX);
  app.dropped = false;
  if (next.includePage && !app.settings.includePageContext) await updateSetting({ includePageContext: true });
  el.prompt.focus();
  await refreshPreview();
}

// ---- Wiring and boot ------------------------------------------------------

function listenToStorage() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.skipPermissions) {
      app.skipPermissions = changes.skipPermissions.newValue === true;
      refreshControls();
    }
    if (area === 'session' && changes[PENDING_KEY]?.newValue) pendingFlow.consume();
    if (area === 'local' && changes.settings) reloadSettings();
  });
}

function bindEvents() {
  el['btn-send'].addEventListener('click', () => (app.activeRun ? stopRun() : sendMessage()));
  el.prompt.addEventListener('keydown', (event) => {
    if (!shouldSendOnKey(event)) return;
    event.preventDefault();
    sendMessage();
  });
  el.prompt.addEventListener('input', () => autosize(el.prompt, TEXTAREA_MAX_PX));
  el['btn-new'].addEventListener('click', newChat);
  el['btn-ide'].addEventListener('click', openIde);
  el['btn-settings'].addEventListener('click', () => chrome.runtime.openOptionsPage());
  el['btn-retry'].addEventListener('click', connectHost);
  el['model-select'].addEventListener('change', () => updateSetting({ model: el['model-select'].value }));
  el['mode-select'].addEventListener('change', () => updateSetting({ mode: el['mode-select'].value }));
  el['btn-include'].addEventListener('click', toggleInclude);
  el['btn-drop'].addEventListener('click', dropForMessage);
  el['btn-allow'].addEventListener('click', allowSite);
  el.transcript.addEventListener('scroll', onTranscriptScroll);
  el['btn-jump'].addEventListener('click', jumpToLatest);
  doc.addEventListener('visibilitychange', () => {
    if (doc.hidden) return;
    refreshPreview();
    pendingFlow.consume();
  });
  chrome.tabs.onActivated.addListener(() => refreshPreview());
  window.addEventListener('pagehide', flushSave);
  listenToStorage();
}

async function loadPersistedState() {
  const win = await chrome.windows.getCurrent();
  app.windowId = win.id;
  app.settings = await loadSettings();
  app.skipPermissions = await getSkipPermissions();
  app.state = (await loadChat(app.windowId)) ?? initialState();
}

async function boot() {
  app.renderer = createTranscriptRenderer(doc);
  await loadPersistedState();
  bindEvents();
  refreshControls();
  requestRender();
  autosize(el.prompt, TEXTAREA_MAX_PX);
  await pendingFlow.consume();
  refreshPreview();
  await connectHost();
}

boot().catch((error) => {
  setConnection(missingView());
  showToast(`Startup failed: ${errorText(error)}`);
});
