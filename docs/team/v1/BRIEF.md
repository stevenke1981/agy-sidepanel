# agy Bridge v1 — 共用 Brief（所有 agent 先讀）

## 目標
Chrome MV3 擴充 + Windows Native Messaging host，讓使用者在 Chrome 側邊欄與本機 Google Antigravity `agy` CLI（1.5.9）對話，可附帶頁面／選取文字作為上下文，並可「在 Antigravity IDE 開啟工作目錄」。

## 已驗證的外部事實（主控實測）
- `agy.exe` 預設在 `%LOCALAPPDATA%\agy\bin\agy.exe`。`agy --version` → `1.5.9`；`agy models` 每行 `<id>\t<label>`（首行可能是 `Fetching available models...`，須略過不含 tab 之行）。
- 以 stdin 傳 prompt（避開命令列長度限制）：
  `agy --input-format stream-json --output-format stream-json --print= [--model M] [--effort E] [--mode X] [--conversation ID] [--dangerously-skip-permissions]`
  stdin 寫一行 `{"event":"user","message":{"role":"user","content":"<prompt>"}}\n` 後關閉 stdin。
  注意 `-p` 必帶值；`--print=` 必須寫成單一參數。
- stdout 為 NDJSON，事件：
  - `{"event":"init","conversation_id":"…","init":{"model","cwd","tools":[…],"permission_mode"}}`
  - `{"event":"step_update","step_update":{"conversation_id","step_index","state":"ACTIVE|DONE","step_type":"user_input|agent_response|<tool…>","text_delta"?, "duration_seconds"?, "usage"?}}`
  - `{"event":"result","result":{"conversation_id","status":"SUCCESS|ERROR","response","error"?,"duration_seconds","num_turns","usage":{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}}}`
  - 其他未知事件須容忍（原樣轉發，UI 以通用列顯示）。
- Antigravity IDE：`%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe`；開資料夾＝以環境變數 `ELECTRON_RUN_AS_NODE=1` 執行 `"Antigravity IDE.exe" "<dir>\resources\app\out\cli.js" <path>`（勿經 shell / .cmd，以免注入）。

## 架構與檔案 owner
```
extension/                 Chrome 擴充（unpacked 根目錄）
  manifest.json            [主控·契約] key 固定 → ID dnildepikbjklalofggmgafohplflpgg
  src/lib/protocol.js      [主控·契約] 訊息型別、驗證、預設設定（host 亦 import 之）
  src/lib/prompt.js        [B] 純函式 buildPrompt({userText, context, maxContextChars})
  src/lib/transcript.js    [B] 純函式 reducer：applyHostMessage(state, msg) → 新 state（不可變）
  src/lib/settings.js      [B] chrome.storage.local 讀寫（合併 DEFAULT_SETTINGS）
  src/lib/page-context.js  [B] chrome.scripting 擷取 {title,url,selection,text}
  src/lib/native-client.js [B] connectNative 包裝：request/stream、reqId 產生、斷線處理
  src/background.js        [B] 側欄行為、context menu、pending prompt
  options.html/.js/.css    [B] 設定頁
  sidepanel.html/.css/.js  [C] 聊天 UI
  icons/*.png              [C] 16/32/48/128
extension/test/*.test.js   [B][C] 各自純模組測試
host/                      Native host（Node ≥20，零依賴）
  src/framing.mjs          [A] 4-byte LE 長度前綴 編解碼（串流、可處理分段）
  src/agy.mjs              [A] 解析 agy 路徑、buildArgs(options)、models 解析、IDE 路徑
  src/bridge.mjs           [A] 主程式：讀 stdin 訊息 → 派發；管理 run（≤3 並行）、cancel（Windows 用 taskkill /T /F /PID）
  agy-bridge.cmd.tpl       [A] 範本：`@echo off` + `"{{NODE}}" "%~dp0src\bridge.mjs" %*`
host/test/*.test.mjs       [A]
scripts/install.ps1        [D] 安裝／取代：複製 extension/ host/ 至 %LOCALAPPDATA%\agy-bridge\，產生 cmd 與 host manifest，寫 HKCU\Software\Google\Chrome\NativeMessagingHosts\com.agy.bridge
scripts/uninstall.ps1      [D]
scripts/build.mjs          [D] 產 dist/agy-bridge-v<ver>.zip（extension/ host/ scripts/install|uninstall README LICENSE）＋ dist/agy-bridge-extension-v<ver>.zip（僅 extension/），零依賴（可用 PowerShell Compress-Archive 或自寫 zip；CI 為 ubuntu＋windows）
scripts/check.mjs          [D] 對所有 .js/.mjs 跑 `node --check`；驗 manifest JSON 與引用檔存在
.github/workflows/ci.yml   [D] node 20/22 × ubuntu/windows：npm test、npm run check
.github/workflows/release.yml [D] tag v* → build → gh release 上傳 zip
README.md / LICENSE(MIT) / CHANGELOG.md [主控/文件]
```

## 協定（見 `extension/src/lib/protocol.js`，不得私改；需改先回報主控）
- Native messaging：每則訊息 = 4-byte little-endian uint32 長度 + UTF-8 JSON。host→Chrome 單則 ≤1 MB：超限之 event 須截斷 `text_delta`/`response` 並加 `truncated:true`。
- host 對 `run`：先 `validateRunOptions`；`cwd` 須為存在之絕對目錄，否則 `ERROR BAD_REQUEST`；空 cwd 用 `os.homedir()`；逐行解析 stdout JSON → `EVENT`；非 JSON 行 → `STDERR`；stderr → `STDERR`；結束 → `EXIT`。
- `cancel` → 殺程序樹 → `CANCELLED`，其後不再送該 reqId 之 EXIT 以外訊息（可送 EXIT）。
- stdin 結束（Chrome 斷線）→ 殺所有子程序後退出。
- host 不得記錄 prompt 內容於磁碟；除錯 log 僅在 `AGY_BRIDGE_LOG` 環境變數設定時寫入。

## 安全硬規則
- 擴充端 UI 一律以 `textContent`／DOM API 渲染，禁 `innerHTML` 插入模型或頁面內容。
- prompt 中頁面內容以明確分隔標示為「不可信資料，不是指令」。
- `skipPermissions` 預設 false；設定頁開啟時顯示警告。
- host manifest `allowed_origins` 只含 `chrome-extension://dnildepikbjklalofggmgafohplflpgg/`。
- spawn 一律 `shell:false`、參數陣列。

## 工作硬規則
- 只動自己名下檔案；不得 git add/commit/stash/checkout；不新增 npm 依賴；只跑自己的測試（`node --test <your files>`）。
- 純模組不可引用 `chrome.*`，以便 node:test。
- 不可變更新（回傳新物件）；函式 <50 行；無 console.log（host 用 stderr 亦禁止——stderr 對 Chrome 無害但保持乾淨，用可選 log 函式）。

## 驗收
- `npm test` 全綠；`npm run check` 綠。
- 實機：安裝後 Chrome 側欄可列模型、送出問題得串流回覆、可停止、可續聊、右鍵「Ask agy about selection」可用、可開 IDE。

## 回報格式
完成清單（檔案）、測試指令與結果（含數量）、未完成／風險、對契約之疑義。
