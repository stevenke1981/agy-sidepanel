# Changelog

## [1.0.0] - 2026-11-16
### Added
- Chrome MV3 side panel to chat with the local Google Antigravity `agy` CLI (streaming, stop, continue conversation, model/mode selection).
- Page and selection context with nonce-fenced untrusted-data framing; context-menu entries "Ask agy about selection" and "Send page to agy".
- "Open workspace in Antigravity IDE".
- Zero-dependency Node native messaging host (`com.agy.bridge`) with strict request validation, byte-aware 1 MB message limit, process-tree cancel and idle timeout.
- `scripts/install.ps1` / `uninstall.ps1` (replace-in-place install with backup), zip build, CI and release workflows.
