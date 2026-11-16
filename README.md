# agy Bridge — Antigravity `agy` CLI in a Chrome side panel

Chat with the local **Google Antigravity `agy` CLI** from a Chrome side panel. You can attach the current page or a selection as context, stream the answer, stop a run, continue the conversation and open the workspace in **Antigravity IDE**.

```
Chrome side panel ──native messaging──▶ host (Node, zero deps) ──stdin/stream-json──▶ agy.exe
                                                └──────────────▶ Antigravity IDE (open folder)
```

## Features
- Streaming chat with model, mode (`plan` / `accept-edits` / `auto`) and effort settings. The model list comes from `agy models`.
- Conversations continue through agy's `conversation_id`. Tool steps appear as collapsible rows with token usage.
- **Page context**: the active tab's title, URL, selection and text, capped by `maxContextChars`. It is sent inside a nonce-fenced block marked as untrusted data. A preview chip lets you drop it for a single message.
- Right-click menu items: **Ask agy about selection** and **Send page to agy**.
- **Open workspace in IDE** launches Antigravity IDE on the working directory.
- `Alt+Shift+A` opens the panel.

## Requirements
- Windows 10/11, Chrome 116 or later
- Node.js 20 or later on `PATH`
- `agy` CLI. The host looks for `AGY_PATH`, then `%LOCALAPPDATA%\agy\bin\agy.exe`, then `PATH`.
- Optional: Antigravity IDE in `%LOCALAPPDATA%\Programs\Antigravity IDE`

## Install / upgrade (replaces in place)
1. Download `agy-bridge-v<ver>.zip` from Releases and extract it, or clone this repo.
2. Run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
   ```
   The script copies the extension and host to `%LOCALAPPDATA%\agy-bridge` and backs up any previous install to `agy-bridge.bak`. It then writes `host\com.agy.bridge.json` and registers it under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.agy.bridge`.
3. First time only: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select `%LOCALAPPDATA%\agy-bridge\extension`. After later upgrades, click **reload** on the card instead.
   The manifest pins the extension ID `dnildepikbjklalofggmgafohplflpgg`, so the native host only accepts this extension.

Uninstall: `scripts\uninstall.ps1`. Add `-Purge` to also delete the workspace.

## Security model
- The host runs only `agy.exe` and the IDE. It always uses `shell:false` and argument arrays, and validates every request against `extension/src/lib/protocol.js`. Values may not start with `-`. `cwd` must be a drive-letter absolute path; UNC paths, device paths and `..` are rejected.
- Default working directory is `%LOCALAPPDATA%\agy-bridge\workspace`, not your home folder. The default mode is `plan`, which is read-only in agy.
- **Prompt-injection guard**: page context is only sent in `plan` mode without skip-permissions. The host rejects any other combination, because page text is untrusted and must not drive file writes.
- "Skip permissions" lasts for the browser session only (`chrome.storage.session`). While it is on, the panel shows a red banner.
- The UI renders model and page text with `textContent` only. It never uses `innerHTML`.
- The host never writes prompts to disk. A debug log is written only when `AGY_BRIDGE_LOG` is set.

## Development
```bash
npm test          # node:test across host/, extension/, scripts/
npm run check     # node --check + manifest reference validation
npm run build     # dist/agy-bridge-v<ver>.zip, extension zip, SHA256SUMS.txt
AGY_BRIDGE_E2E=1 node --test host/test/e2e.test.mjs   # live test against real agy
```
Layout: `extension/` (MV3, no bundler), `host/` (native host), `scripts/` (install, build, checks), `docs/team/v1/BRIEF.md` (design contract).

## License
MIT
