import * as vscode from 'vscode';

type Locale = 'en' | 'zh-cn';
let current: Locale = 'en';

const dict: Record<Locale, Record<string, string>> = {
  'en': {
    'channel.name': 'PHP Debug Manager',
    'startup.loading': '[Startup] Extension loading: {0}',
    'view.init.done': '[View] Manager view initialized: {0} elapsed={1}ms',
    'guard.started': '[Guard] Staging guard started: {0} elapsed={1}ms',
    'startup.loaded': '[Startup] Extension loaded: {0} elapsed={1}ms',

    'insert.noSelection': 'No selection, cannot insert.',
    'insert.inString.skip': 'Selection seems inside a string, skipped.',
    'insert.selectFullCall': 'Select the full call expression (with parentheses), skipped.',
    'insert.notVariableOrCallable': 'Selection is not a variable or callable expression, skipped.',
    'brace.unbalanced': 'Unbalanced braces.',

    'guard.strict.blocked': 'Debug statements detected. Remove them before committing.',
    'guard.warn.title': 'Current file contains debug statements (found {0}). Continue to stage?',
    'btn.continue': 'Continue',
    'btn.revealLocation': 'Reveal Location',
    'btn.revealInManager': 'Reveal in Manager',
    'pick.reveal.placeholder': 'Select a location to reveal',

    'log.scan.manual': '[Scan] Manual scan: files={0} statements={1} time={2}ms total={3}ms',
    'log.scan.auto': '[Scan] Auto scan completed: files={0} statements={1} time={2}ms',
    'log.scan.errors': '[Scan] Failed files={0}',
    'status.scanning': '$(sync~spin) Scanning debug statements...',
    'status.count': '$(bug) Debug: {0}',
    'status.tooltip': 'Click to open Debug Manager\nTotal: {0} statements',
    'status.scan.tooltip': 'Scanned {0} files, found {1} statements\nElapsed: {2}ms',
    'error.scan.failed': 'Debug statement scan failed: {0}',

    'bookmark.added': 'Bookmark added',
    'bookmark.removed': 'Bookmark removed',
    'bookmarks.cleared': 'All bookmarks cleared',
    'export.none': 'No debug statements to export',
    'export.saved': 'Exported debug statements to: {0}',
    'export.saved.openFailed': 'File saved but failed to open: {0}',
    'export.failed': 'Export failed: {0}',
    'copy.content.ok': 'Debug content copied to clipboard',
    'copy.path.ok': 'File path copied to clipboard',
    'copy.failed': 'Copy failed: {0}',
    'exclude.added': 'Added to exclude list',
    'exclude.removed': 'Removed from exclude list',

    'confirm.clear.statement': 'Confirm to clear this debug statement?\n{0}',
    'btn.confirm': 'Confirm',
    'info.cleared.statement': 'Debug statement cleared',
    'error.clear.statement': 'Failed to clear debug statement',
    'confirm.clear.file': 'Clear all debug statements in file?\nFile: {0}\nTotal {1}',
    'info.cleared.file': 'Cleared {0} debug statements',
    'confirm.clear.all': 'Clear ALL debug statements?\nTotal {0}',
    'btn.clear.all': 'Clear All',

    'menu.open.settings.exclude': '[Config] Open exclude settings',
    'menu.config.patterns': '[Config] Open custom pattern settings',

    'badge.debug.total.tooltip': 'Total debug statements',

    'open.file.failed': 'Failed to open file: {0}',
    'line': 'line',
    'view.manager.name': 'PHP Debug Manager',
    'view.bookmarks.name': 'Debug Statement Bookmarks'
  },
  'zh-cn': {
    'channel.name': 'PHP 调试管理器',
    'startup.loading': '[启动] 插件加载中: {0}',
    'view.init.done': '[视图] 管理器视图初始化完成: {0} 耗时={1}ms',
    'guard.started': '[守卫] 暂存守卫已启动: {0} 耗时={1}ms',
    'startup.loaded': '[启动] 插件加载完成: {0} 耗时={1}ms',

    'insert.noSelection': '未选中任何内容，无法插入变量打印。',
    'insert.inString.skip': '选中内容看起来位于字符串中，已跳过插入。',
    'insert.selectFullCall': '请选中完整的调用表达式（包含括号），已跳过插入。',
    'insert.notVariableOrCallable': '选中内容不是变量或可调用表达式，已跳过插入。',
    'brace.unbalanced': '大括号不匹配。',

    'guard.strict.blocked': '检测到调试语句，请移除后再提交',
    'guard.warn.title': '当前文件包含调试语句（共发现{0}处），确认要继续添加吗？',
    'btn.continue': '继续',
    'btn.revealLocation': '查看位置',
    'btn.revealInManager': '在管理器中查看',
    'pick.reveal.placeholder': '选择要查看的位置',

    'log.scan.manual': '[扫描] 手动扫描完成: 文件={0} 语句={1} 耗时={2}ms 总耗时={3}ms',
    'log.scan.auto': '[扫描] 自动扫描完成: 文件={0} 语句={1} 耗时={2}ms',
    'log.scan.errors': '[扫描] 失败文件数量={0}',
    'status.scanning': '$(sync~spin) 扫描调试语句中...',
    'status.count': '$(bug) 调试: {0}',
    'status.tooltip': '点击查看调试语句管理器\n总计: {0} 个调试语句',
    'status.scan.tooltip': '扫描了 {0} 个文件，找到 {1} 个调试语句\n扫描耗时: {2}ms',
    'error.scan.failed': '调试语句扫描失败: {0}',

    'bookmark.added': '已添加书签',
    'bookmark.removed': '已移除书签',
    'bookmarks.cleared': '已清除所有调试语句书签',
    'export.none': '当前没有调试语句可导出',
    'export.saved': '调试语句清单已导出到: {0}',
    'export.saved.openFailed': '文件已保存，但打开失败: {0}',
    'export.failed': '导出失败: {0}',
    'copy.content.ok': '调试语句内容已复制到剪贴板',
    'copy.path.ok': '文件路径已复制到剪贴板',
    'copy.failed': '复制失败: {0}',
    'exclude.added': '已添加到排除列表',
    'exclude.removed': '已从排除列表移除',

    'confirm.clear.statement': '确定要清除这个调试语句吗？\n{0}',
    'btn.confirm': '确定',
    'info.cleared.statement': '调试语句已清除',
    'error.clear.statement': '清除调试语句失败',
    'confirm.clear.file': '确定要清除文件中的所有调试语句吗？\n文件: {0}\n共 {1} 个调试语句',
    'info.cleared.file': '已清除 {0} 个调试语句',
    'confirm.clear.all': '确定要清除所有调试语句吗？\n共 {0} 个调试语句',
    'btn.clear.all': '全部清除',

    'menu.open.settings.exclude': '[配置] 打开排除路径设置',
    'menu.config.patterns': '[配置] 打开自定义模式配置',

    'badge.debug.total.tooltip': '调试语句总数',

    'open.file.failed': '无法打开文件: {0}',
    'line': 'line',
    'view.manager.name': 'PHP 调试管理器',
    'view.bookmarks.name': '调试语句书签'
  }
};

export function setLocale(locale: 'system' | 'en' | 'zh-cn'): void {
  if (locale === 'system') {
    const sys = (vscode.env.language || '').toLowerCase();
    current = sys.startsWith('zh') ? 'zh-cn' : 'en';
  } else {
    current = locale;
  }
}

export function t(key: string, ...args: Array<string | number>): string {
  const base = dict[current][key] || dict['en'][key] || key;
  if (!args || args.length === 0) return base;
  let out = base;
  for (let i = 0; i < args.length; i++) {
    out = out.replace(new RegExp(`\\{${i}\\}`, 'g'), String(args[i]));
  }
  return out;
}