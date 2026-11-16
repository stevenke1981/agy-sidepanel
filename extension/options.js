// Options page. All dynamic text is set with textContent or DOM constructors; nothing is inserted as HTML.
import { EFFORTS, MODES, isSafeAbsolutePath, validateRunOptions } from './src/lib/protocol.js';
import { NativeClient } from './src/lib/native-client.js';
import { getSkipPermissions, loadSettings, saveSettings, setSkipPermissions } from './src/lib/settings.js';

const MIN_CONTEXT_CHARS = 1000;
const MAX_CONTEXT_CHARS = 100000;
const INSTALL_COMMAND = 'powershell -ExecutionPolicy Bypass -File scripts\\install.ps1';

const $ = (id) => document.getElementById(id);

const els = {
  form: $('settings-form'),
  hostStatus: $('host-status'),
  hostHint: $('host-hint'),
  installCommand: $('install-command'),
  model: $('model'),
  modelList: $('model-list'),
  modelError: $('model-error'),
  effort: $('effort'),
  mode: $('mode'),
  modeError: $('mode-error'),
  cwd: $('cwd'),
  cwdError: $('cwd-error'),
  includePageContext: $('includePageContext'),
  maxContextChars: $('maxContextChars'),
  maxError: $('max-error'),
  skipPermissions: $('skipPermissions'),
  skipState: $('skip-state'),
  skipError: $('skip-error'),
  saveStatus: $('save-status'),
};

/** Field name -> { input, error } for inline validation. */
const FIELDS = {
  model: { input: els.model, error: els.modelError },
  mode: { input: els.mode, error: els.modeError },
  cwd: { input: els.cwd, error: els.cwdError },
  maxContextChars: { input: els.maxContextChars, error: els.maxError },
  skipPermissions: { input: els.skipPermissions, error: els.skipError },
};

/** @param {unknown} err @returns {string} */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {HTMLSelectElement} select
 * @param {Array<[string, string]>} entries [value, label]
 */
function fillSelect(select, entries) {
  select.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
}

/**
 * @param {HTMLElement} el
 * @param {string} text
 * @param {'ok'|'error'|'pending'} [tone]
 */
function setStatus(el, text, tone = 'pending') {
  el.textContent = text;
  el.dataset.tone = tone;
}

/** @param {string} field @param {string} message empty clears the error */
function setFieldError(field, message) {
  const { input, error } = FIELDS[field];
  error.textContent = message;
  error.hidden = message === '';
  input.setAttribute('aria-invalid', String(message !== ''));
}

/** @returns {{model: string, effort: string, mode: string, cwd: string, includePageContext: boolean, maxContextChars: number}} */
function readForm() {
  return {
    model: els.model.value.trim(),
    effort: els.effort.value,
    mode: els.mode.value,
    cwd: els.cwd.value.trim(),
    includePageContext: els.includePageContext.checked,
    maxContextChars: Number(els.maxContextChars.value),
  };
}

/** @param {number} value @returns {boolean} */
function isContextBudgetValid(value) {
  return Number.isInteger(value) && value >= MIN_CONTEXT_CHARS && value <= MAX_CONTEXT_CHARS;
}

/**
 * Mirror the host guards: model format, cwd path, and the page-context vs skipPermissions/auto conflicts.
 * @param {ReturnType<typeof readForm>} values
 * @param {boolean} skipPermissions
 * @returns {Record<string, string>} field -> message
 */
function validateValues(values, skipPermissions) {
  const errors = {};
  if (values.model && !validateRunOptions({ model: values.model }).ok) {
    errors.model = '模型名稱格式不正確：須以英數開頭，僅含英數、. _ -（最長 80 字元）。';
  }
  if (values.cwd && !isSafeAbsolutePath(values.cwd)) {
    errors.cwd = '請輸入磁碟機絕對路徑，例如 D:\\專案（不可含 .. 或 UNC 路徑）。';
  }
  if (!isContextBudgetValid(values.maxContextChars)) {
    errors.maxContextChars = `請輸入 ${MIN_CONTEXT_CHARS} 至 ${MAX_CONTEXT_CHARS} 之間的整數。`;
  }
  if (values.includePageContext && values.mode === 'auto') {
    errors.mode = 'auto 模式不可與頁面內容併用，請關閉頁面上下文或改用其他模式。';
  }
  if (values.includePageContext && skipPermissions) {
    errors.skipPermissions = '略過權限詢問不可與頁面內容併用，請關閉頁面上下文或取消此選項。';
  }
  return errors;
}

/** @param {Record<string, string>} errors @returns {void} */
function showErrors(errors) {
  for (const field of Object.keys(FIELDS)) setFieldError(field, errors[field] ?? '');
}

function updateSkipState() {
  const enabled = els.skipPermissions.checked;
  setStatus(els.skipState, enabled ? '目前工作階段：已啟用（尚未儲存則不生效）' : '目前：未啟用', enabled ? 'error' : 'pending');
}

/** @param {object} info RES.HELLO message */
function renderHostOk(info) {
  const ide = info.ideAvailable ? 'Antigravity IDE 可用' : 'Antigravity IDE 未找到';
  setStatus(els.hostStatus, `已連線：agy ${info.agyVersion ?? '?'}（${info.agyPath ?? '?'}），${ide}。`, 'ok');
  els.hostHint.hidden = true;
  if (info.defaultCwd) els.cwd.placeholder = `留空＝${info.defaultCwd}`;
}

/** @param {unknown} err */
function renderHostError(err) {
  setStatus(els.hostStatus, `無法連線到 native host：${messageOf(err)}`, 'error');
  els.installCommand.textContent = INSTALL_COMMAND;
  els.hostHint.hidden = false;
}

/** @param {Array<{id: string, label?: string}>} models */
function fillModelList(models) {
  els.modelList.replaceChildren(...models.map((m) => {
    const option = document.createElement('option');
    option.value = m.id;
    option.label = m.label || m.id;
    return option;
  }));
}

/** @param {NativeClient} client */
async function checkHost(client) {
  setStatus(els.hostStatus, '檢查中…');
  try {
    renderHostOk(await client.hello());
    fillModelList(await client.listModels());
  } catch (err) {
    renderHostError(err);
  }
}

async function populateForm() {
  const [settings, skipPermissions] = await Promise.all([loadSettings(), getSkipPermissions()]);
  els.model.value = settings.model;
  els.effort.value = settings.effort;
  els.mode.value = settings.mode;
  els.cwd.value = settings.cwd;
  els.includePageContext.checked = settings.includePageContext;
  els.maxContextChars.value = String(settings.maxContextChars);
  els.skipPermissions.checked = skipPermissions;
  updateSkipState();
}

/** @param {SubmitEvent} event */
async function onSubmit(event) {
  event.preventDefault();
  const values = readForm();
  const skipPermissions = els.skipPermissions.checked;
  const errors = validateValues(values, skipPermissions);
  showErrors(errors);
  const firstInvalid = Object.keys(errors)[0];
  if (firstInvalid) {
    setStatus(els.saveStatus, '請修正紅字欄位後再儲存。', 'error');
    FIELDS[firstInvalid].input.focus();
    return;
  }
  try {
    await saveSettings(values);
    await setSkipPermissions(skipPermissions);
    setStatus(els.saveStatus, '已儲存。', 'ok');
  } catch (err) {
    setStatus(els.saveStatus, `儲存失敗：${messageOf(err)}`, 'error');
  }
}

function init() {
  fillSelect(els.effort, [['', 'agy 預設'], ...EFFORTS.map((e) => [e, e])]);
  fillSelect(els.mode, MODES.map((m) => [m, m]));
  els.form.addEventListener('submit', onSubmit);
  els.skipPermissions.addEventListener('change', updateSkipState);

  const client = new NativeClient();
  client.onDisconnect((message) => renderHostError(new Error(message)));
  window.addEventListener('pagehide', () => client.disconnect());

  populateForm().catch((err) => setStatus(els.saveStatus, `載入設定失敗：${messageOf(err)}`, 'error'));
  checkHost(client);
}

init();
