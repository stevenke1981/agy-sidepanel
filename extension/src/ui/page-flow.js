// Page-context flow for the composer: live preview, send-time gating and site permission.
// The factory receives the mutable panel state (`app`) plus two callbacks; it owns no DOM.
import { getActiveTabContext, requestSiteAccess } from '../lib/page-context.js';
import { decidePageContext, unavailableNotice } from './send-plan.js';
import { errorText } from './view-format.js';

/**
 * @param {object} deps
 * @param {object} deps.app   panel state: settings, skipPermissions, dropped, preview, previewToken
 * @param {() => void} deps.render    repaint the context area after preview/state changes
 * @param {(text: string) => void} deps.notify  transient toast
 */
export function createPageFlow({ app, render, notify }) {
  async function readPage() {
    try {
      return await getActiveTabContext({ maxChars: app.settings.maxContextChars });
    } catch (error) {
      notify(`Could not read page: ${errorText(error)}`);
      return { ok: false, reason: 'error' };
    }
  }

  async function refreshPreview() {
    const token = ++app.previewToken;
    app.preview = null;
    render();
    if (!app.settings.includePageContext) return;
    const result = await readPage();
    if (token !== app.previewToken) return;
    app.preview = result;
    render();
  }

  /** @returns {Promise<{context: object|null, notices: string[]}>} */
  async function resolvePageContext() {
    const wantPage = app.settings.includePageContext && !app.dropped;
    const gate = decidePageContext({ wantPage, skipPermissions: app.skipPermissions, mode: app.settings.mode });
    if (!gate.use) return { context: null, notices: gate.notice ? [gate.notice] : [] };
    const result = await readPage();
    if (result.ok) return { context: result.context, notices: [] };
    return { context: null, notices: [unavailableNotice(result.reason)] };
  }

  async function allowSite() {
    const origin = app.preview?.origin;
    if (!origin) return;
    try {
      const res = await requestSiteAccess(origin);
      const granted = res === true || res?.granted === true;
      if (granted) await refreshPreview();
      else notify('Permission was not granted.');
    } catch (error) {
      notify(`Permission request failed: ${errorText(error)}`);
    }
  }

  return { readPage, refreshPreview, resolvePageContext, allowSite };
}
