[English](README.md) | 简体中文
# PHP 调试管理器（含 VarDumper 工具）

一个专注于“调试语句管理”的 VS Code 扩展。主功能是 PHP 调试管理器（树视图、书签、导出、日志、国际化），并提供 VarDumper 快捷插入等特色功能。

## ✨ 功能特性

### 🔍 智能扫描
- 自动扫描项目中的所有 PHP 文件
- 识别多种调试语句：`var_dump`、`print_r`、`error_log`、`debug_backtrace` 等
- 支持自定义调试语句模式
- 树状层级展示：文件路径 → 行号 → 调试内容

### 🎯 交互操作
- **快速跳转**：点击条目直接定位到对应文件的指定行
- **一键清除**：支持单个、按文件、全局批量清除调试语句（书签项保护，不被清除）
- **展开/折叠**：灵活的树状结构展示
- **上下文显示**：显示调试语句周围的代码片段

### 🚀 实时监控
- 文件变化自动检测和更新
- 新增调试语句时自动刷新侧边栏
- 支持手动刷新和自动扫描模式，输出面板记录扫描耗时与结果（中文/英文）

### 🧰 暂存守卫（SCM）
- 三种模式：
  - 严格 strict：拦截含调试语句的文件添加到暂存区并提示
  - 警告 warn：先撤销暂存，弹窗“继续/查看位置/在管理器中查看”，点“继续”才允许重新暂存
  - 宽松 lenient：仅记录日志，不影响暂存
- 可在设置中启用/关闭并切换模式，默认严格模式

### 🧩 VarDumper 快捷工具（附带）
- 快捷键：mac `cmd+shift+/`，win/linux `ctrl+shift+/`
- 插入位置智能分析：分号后一行、空块内插入并匹配缩进，避免插入到数组/参数列表
- 支持选中变量、函数/静态方法调用；在字符串内或选区不完整时将提示并跳过

### ⚙️ 灵活配置
- 自定义调试语句匹配模式
- 配置自动扫描行为
- 控制状态栏显示
- 支持多种扫描选项；支持 `phpVarDumper.language` 设置运行时语言（system/en/zh-cn，默认 system）

### 🌐 国际化
- 清单文案随 VS Code UI 语言切换
- 运行时文案（弹窗、状态栏、日志、树标签）可通过设置切换英文/中文

## 🛠️ 安装和使用

### 安装扩展
1. 下载扩展包
2. 在 VS Code 中通过扩展市场安装
3. 或者使用 VSIX 文件手动安装

### 基本使用
1. 打开包含 PHP 文件的项目
2. 在侧边栏中找到 "PHP Debug Manager" 图标
3. 点击即可查看项目中的所有调试语句
4. 使用右键菜单或工具栏按钮进行操作

## 📋 常用命令

| 命令 | 快捷键 | 描述 |
|------|--------|------|
| `phpVarDumper.dumpVariable` | mac: `cmd+shift+/` / win/linux: `ctrl+shift+/` | 在光标位置插入 var_dump 语句 |
| `phpVarDumper.debugManager.refresh` | - | 刷新调试语句列表 |
| `phpVarDumper.debugManager.focus` | - | 聚焦到调试管理器 |
| `phpVarDumper.debugManager.clearAll` | - | 清除所有调试语句 |
| `phpVarDumper.debugManager.export` | - | 导出调试语句清单 |
| `phpVarDumper.debugManager.scanNow` | - | 立即扫描调试语句 |

## ⚙️ 配置选项（示例）

在 VS Code 设置中搜索 `phpVarDumper` 进行配置：

```json
{
  "phpVarDumper.customPatterns": [
    "var_dump",
    "print_r",
    "error_log",
    "debug_backtrace",
    "die",
    "exit"
  ],
  "phpVarDumper.autoScan": true,
  "phpVarDumper.scanOnStartup": true,
  "phpVarDumper.showStatusBar": true,
  "phpVarDumper.stagingGuard.enabled": true,
  "phpVarDumper.stagingGuard.mode": "strict",
  "phpVarDumper.language": "system"
}
```

### 配置说明

- `phpVarDumper.customPatterns`: 自定义调试语句匹配模式
- `phpVarDumper.autoScan`: 是否启用自动扫描
- `phpVarDumper.scanOnStartup`: 启动时是否自动扫描
- `phpVarDumper.showStatusBar`: 是否在状态栏显示调试信息
- `phpVarDumper.stagingGuard.*`: 暂存守卫开关与模式
- `phpVarDumper.language`: 运行时语言（system/en/zh-cn）

## 🎯 使用场景

### 开发阶段
- 快速定位项目中的所有调试语句
- 临时禁用/启用调试输出
- 跟踪调试语句的使用情况

### 代码审查
- 确保生产代码中没有遗留调试语句
- 分析调试语句的分布和密度
- 生成调试语句报告

### 生产部署
- 一键清理所有调试语句
- 防止调试信息泄露
- 提高代码安全性和性能

## 📊 性能表现（示例项目）

- **扫描速度**: 大型项目（1000+文件）扫描时间 < 2秒
- **内存占用**: 扫描过程中内存占用 < 50MB
- **响应延迟**: 所有操作响应时间 < 100ms

## 🔧 技术实现（概要）

### 核心组件
- `DebugScanner`: 调试语句扫描器
- `DebugDataProvider`: 数据提供器和树状结构管理
- `DebugManagerView`: 调试管理器视图

### 扫描算法与守卫
- 智能文件过滤与缓存；增量扫描；内存使用优化
- 扫描耗时与结果记录到输出面板；守卫在暂存变更时触发扫描并提示

## 🚨 异常处理

- 自动记录扫描失败的文件和原因
- 提供重试机制
- 只读文件智能检测和提示
- 详细的错误日志记录

## 🔮 计划中的功能
- CI/CD 集成支持
- 团队协作功能
- 调试语句使用统计
- 更丰富的导出格式

### API 接口
扩展提供了丰富的 API 接口，支持自定义功能开发：
- 扫描结果获取
- 调试语句操作
- 配置管理
- 事件监听

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！在贡献代码前，请：

1. 阅读项目文档和代码规范
2. 创建功能分支
3. 编写测试用例
4. 提交详细的变更说明

## 📄 许可证

MIT License - 详见 LICENSE 文件

## 💡 反馈和支持

- 提交 Issue: [GitHub Issues](https://github.com/your-repo/issues)
- 邮件联系: your-email@example.com
- 文档更新: 欢迎提交文档改进建议

---

**享受干净的代码，告别调试烦恼！** 🎉