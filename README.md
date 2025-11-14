English | [简体中文](README.zh-CN.md)
# PHP Debug Manager (with Featured VarDumper tool)

A VS Code extension focused on managing debug statements in PHP. The main feature is the Debug Manager (tree view, bookmarks, export, logs, i18n), plus a featured VarDumper insertion tool.

## Features

### Scanning
- Automatically scans PHP files
- Supports multiple patterns: `var_dump`, `print_r`, `error_log`, `debug_backtrace`, etc.
- Custom patterns
- Tree view: file → line → content

### Interactions
- Jump to location
- Clear statements (single/file/global; bookmarked items are protected)
- Expand/collapse
- Reveal in Manager from SCM warning dialog

### Monitoring
- Auto refresh on file changes
- Manual refresh and auto scan; output channel logs time and results (EN/ZH)

### SCM Staging Guard
- Modes:
  - strict: block staging when debug statements exist
  - warn: unstage first, require “Continue” to re-stage; supports “Reveal Location” and “Reveal in Manager”
  - lenient: log only
- Configurable and enabled by default (strict)

### VarDumper Tool (featured)
- Shortcut: mac `cmd+shift+/`, win/linux `ctrl+shift+/`
- Smart insertion after semicolon or into empty block, matching indentation
- Avoids arrays/argument lists; warns and skips in strings or incomplete selections

### Configuration (example)
```json
{
  "phpDebugManager.customPatterns": ["var_dump", "print_r", "error_log", "debug_backtrace", "die", "exit"],
  "phpDebugManager.autoScan": true,
  "phpDebugManager.scanOnStartup": true,
  "phpDebugManager.showStatusBar": true,
  "phpDebugManager.stagingGuard.enabled": true,
  "phpDebugManager.stagingGuard.mode": "strict",
  "phpDebugManager.language": "system"
}
```

### Internationalization
- Manifest strings follow VS Code UI language
- Runtime strings (dialogs, status bar, logs, tree labels) switchable via setting

## Commands

| Command | Shortcut | Description |
|---|---|---|
| `phpDebugManager.dumpVariable` | mac: `cmd+shift+/` / win/linux: `ctrl+shift+/` | Insert var_dump statement |
| `phpDebugManager.debugManager.refresh` | - | Refresh list |
| `phpDebugManager.debugManager.focus` | - | Focus manager view |
| `phpDebugManager.debugManager.clearAll` | - | Clear all statements |
| `phpDebugManager.debugManager.export` | - | Export list |
| `phpDebugManager.debugManager.scanNow` | - | Scan now |

## Performance (example projects)
- Scan < 2s for 1000+ files
- Low memory footprint during scan

## Implementation (overview)
- Efficient file filtering and caching; incremental scan
- Output logs for scan duration and results; guard integrates with repository state changes

## License & Support
- MIT License
- Issues: GitHub repository

---

Keep your repo clean with organized debugging.