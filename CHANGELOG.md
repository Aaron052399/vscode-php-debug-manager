# Changelog

[English](#english) | [简体中文](#简体中文)

## English

### 1.1.3 - 2025-12-10
- Fixed: Parser state corruption when parsing files with syntax errors
- Improved: Merged consecutive debug statements with trailing `exit;` or `die;` into single record
- Enhanced: Performance optimization for expression validation and scope checking
- Added: Execution time tracking for debug statement insertion (in milliseconds)

### 1.1.2 - 2025-12-10
- Fixed: php-parser dependency not bundled in published extension

### 1.1.1 - 2025-12-10
- (Deprecated) Dependency bundling issue

### 1.1.0 - 2025-12-10
- **Major**: Replaced regex-based scanning with PHP AST parsing (using `php-parser`)
- Added new `phpAstParser.ts` module for accurate PHP syntax analysis
- Improved debug statement detection accuracy, avoiding false positives in strings and comments
- Optimized bracket matching and statement boundary detection using AST
- Simplified VarDumper insertion logic with AST-based validation
- Code cleanup and formatting improvements

### 1.0.6 - 2025-11-17
- Scanner now reads `maxFileSize` and `excludePatterns` strictly from settings (no hardcoded defaults)
- Configuration changes reliably reload and apply during scans

### 1.0.5 - 2025-11-17
- Added Debug Manager view filter (funnel) to hide selected built-in debug types
- Added staging guard types configuration and command to choose intercept types (strict/warn)

### 1.0.4 - 2025-11-14
- Fixed some scanning performance issues

### 1.0.3 - 2025-11-14
- Optimized dynamic display logic of debug statement bookmarks

### 1.0.2 - 2025-11-14
- Default `phpDebugManager.maxFileSize` increased to `10485760` bytes

### 1.0.1 - 2025-11-14
- Initial public release to VS Marketplace

### 1.0.0 - 2025-11-14
- Initial version with Debug Manager and VarDumper tool

## 简体中文

### 1.1.3 - 2025-12-10
- 修复：解析包含语法错误的 PHP 文件后，解析器状态污染导致后续解析失败
- 改进：检测到连续的调试语句和 `exit;` 或 `die;` 时，将其合并为单条记录
- 性能优化：提升表达式验证和作用域检查的速度
- 新增：调试语句插入时记录执行耗时（毫秒级）到输出通道

### 1.1.2 - 2025-12-10
- 修复：php-parser 依赖未打包到发布的扩展中

### 1.1.1 - 2025-12-10
- （已废弃）依赖打包问题

### 1.1.0 - 2025-12-10
- **重大更新**：使用 PHP AST 解析器（php-parser）替代正则表达式进行调试语句扫描
- 新增 `phpAstParser.ts` 模块，封装 PHP 语法树解析功能
- 提升调试语句检测准确性，避免字符串和注释内的误报
- 使用 AST 优化括号匹配和语句边界检测
- 简化 VarDumper 插入逻辑，采用 AST 进行表达式验证
- 代码清理与格式优化

### 1.0.6 - 2025-11-17
- 扫描器严格从设置读取 `maxFileSize` 与 `excludePatterns`（无代码默认值）
- 配置变更在扫描过程中可靠重载并生效

### 1.0.5 - 2025-11-17
- 新增 Debug Manager 漏斗筛选，按内置类型隐藏视图调试语句
- 新增阶段防护拦截类型配置与命令，严格/警告模式按所选类型拦截

### 1.0.4 - 2025-11-14
- 修复了一些扫描的性能问题

### 1.0.3 - 2025-11-14
- 优化调试语句书签动态展示的逻辑

### 1.0.2 - 2025-11-14
- 将默认 `phpDebugManager.maxFileSize` 提升至 `10485760` 字节

### 1.0.1 - 2025-11-14
- 首次公开发布至 VS Marketplace

### 1.0.0 - 2025-11-14
- 初始版本，包含 Debug Manager 与 VarDumper 工具