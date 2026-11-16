# Changelog

## [1.0.1] - 2026-11-16
### Fixed
- When the host disconnects, or a saved chat is restored after the side panel closed mid-run, runs still marked running are now marked failed, so they no longer look active.
- Removed the dead "tool output" branch from the step row; agy reports only tool arguments.

### Changed
- Page context is now only sent in `plan` mode without skip-permissions. `accept-edits` and the agy default mode can write files, so untrusted page text is no longer combined with them. The host enforces the same rule.

## [1.0.0] - 2026-11-16
### Added
- Chrome MV3 side panel to chat with the local Google Antigravity `agy` CLI (streaming, stop, continue conversation, model/mode selection).
- Page and selection context with nonce-fenced untrusted-data framing; context-menu entries "Ask agy about selection" and "Send page to agy".
- "Open workspace in Antigravity IDE".
- Zero-dependency Node native messaging host (`com.agy.bridge`) with strict request validation, byte-aware 1 MB message limit, process-tree cancel and idle timeout.
- `scripts/install.ps1` / `uninstall.ps1` (replace-in-place install with backup), zip build, CI and release workflows.
