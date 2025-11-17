English | [简体中文](README.zh-CN.md)
# PHP Debug Manager (with Featured VarDumper tool)

A VS Code extension focused on managing debug statements in PHP. The main feature is the Debug Manager (tree view, bookmarks, export, logs, i18n), plus a featured VarDumper insertion tool.

## Features

### Scanning
- Automatically scans PHP files
- Supports multiple patterns: `var_dump`, `print_r`, `error_log`, `debug_backtrace`, etc.
  - Tree view: file → line → content

### Interactions
- Jump to location
- Clear statements (single/file/global; bookmarked items are protected)
- Expand/collapse
- Reveal in Manager from SCM warning dialog

### Filtering
- View-level filter with funnel button to hide selected built-in debug types
- Selection persists per workspace;
- Types are system-provided (non-editable): `var_dump`, `print_r`, `echo`, `print`, `var_export`, `printf`, `die`, `exit`, `error_log`, `trigger_error`, `user_error`, `debug_backtrace`, `dump`, `dd`, `xdebug_var_dump`, `xdebug_debug_zval`, `xdebug_break`

### Monitoring
- Auto refresh on file changes
- Manual refresh and auto scan; output channel logs time and results (EN/ZH)

### SCM Staging Guard
- Modes:
  - strict: block staging when debug statements exist
  - warn: unstage first, require “Continue” to re-stage; supports “Reveal Location” and “Reveal in Manager”
  - lenient: log only
- Configurable and enabled by default (strict)
- Intercept types can be configured; strict and warn modes respect your selection
- Command: `phpDebugManager.stagingGuard.configureTypes` (shield icon) opens a multi-select for built-in types

### VarDumper Tool (featured)
- Shortcut: mac `cmd+shift+/`, win/linux `ctrl+shift+/`
- Smart insertion after semicolon or into empty block, matching indentation
- Avoids arrays/argument lists; warns and skips in strings or incomplete selections

### Configuration (example)
```json
{
  "phpDebugManager.autoScan": true,
  "phpDebugManager.scanOnStartup": true,
  "phpDebugManager.showStatusBar": true,
  "phpDebugManager.stagingGuard.enabled": true,
  "phpDebugManager.stagingGuard.mode": "strict",
  "phpDebugManager.stagingGuard.types": [
    "var_dump","print_r","echo","print","var_export","printf",
    "die","exit","error_log","trigger_error","user_error",
    "debug_backtrace","dump","dd","xdebug_var_dump","xdebug_debug_zval","xdebug_break"
  ],
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
| `phpDebugManager.filterTypes` | - | Filter displayed debug types (view funnel) |
| `phpDebugManager.stagingGuard.configureTypes` | - | Configure guard intercept types (strict/warn) |

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