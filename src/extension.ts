import * as vscode from 'vscode';
import { DebugManagerView } from './debugManagerView';
import { DebugScanner } from './debugScanner';
import { StagingGuard } from './stagingGuard';
import { setLocale, t } from './i18n';
import { PhpAstParser } from './phpAstParser';

let currentGuard: StagingGuard | null = null;
let guardCfgListener: vscode.Disposable | null = null;

// AST 解析器工厂函数（避免全局状态污染）
// 每次需要验证时创建新实例，确保没有状态污染
function createAstParser(): PhpAstParser {
  return new PhpAstParser();
}

// 当前命令执行中的临时 parser（在命令期间复用，执行完毕后清空）
let commandScopedParser: PhpAstParser | null = null;

/**
 * 获取命令作用域内的 parser（如果不存在则创建）
 * 用于在单次命令执行中复用 parser，提高性能
 */
function getCommandScopedParser(): PhpAstParser {
  if (!commandScopedParser) {
    commandScopedParser = new PhpAstParser();
  }
  return commandScopedParser;
}

/**
 * 清空命令作用域内的 parser（在命令结束时调用）
 * 确保下一条命令获得一个全新的 parser，避免状态污染
 */
function clearCommandScopedParser(): void {
  commandScopedParser = null;
}

// 输出通道（延迟初始化）
let dumpOutputChannel: vscode.OutputChannel | null = null;

function getDumpOutputChannel(): vscode.OutputChannel {
  if (!dumpOutputChannel) {
    dumpOutputChannel = vscode.window.createOutputChannel(t('dump.log.channel'));
  }
  return dumpOutputChannel;
}

/**
 * 记录调试语句插入日志
 */
function logDumpInsertion(filePath: string, lineNumber: number, expression: string, dumpStatement: string, durationMs: number): void {
  const channel = getDumpOutputChannel();
  const timestamp = new Date().toLocaleString();
  const fileName = filePath.split(/[\/\\]/).pop() || filePath;
  channel.appendLine(t('dump.log.inserted', timestamp, fileName, String(lineNumber), expression, dumpStatement) + ` [${durationMs}ms]`);
}

// ============= AST 验证所有表达式 =============

function analyzeBrackets(editor: vscode.TextEditor, selection: vscode.Selection) {
  const currentLine = editor.document.lineAt(selection.end.line);
  const nextLineIndex = Math.min(selection.end.line + 1, editor.document.lineCount - 1);
  const nextLine = editor.document.lineAt(nextLineIndex);

  // 检测下一行是否为仅包含左大括号的行
  const nextLineIsOpeningBracket = nextLine.text.trim() === '{';
  // 检测下一行是否为仅包含右大括号的行
  const nextLineIsClosingBracket = nextLine.text.trim() === '}';

  // 检测当前行选区右侧是否包含右大括号
  const currentLineTextAfterSelection = currentLine.text.substring(selection.end.character);
  const hasClosingBracketOnRight = currentLineTextAfterSelection.includes('}');

  return {
    nextLineIsOpeningBracket,
    nextLineIsClosingBracket,
    hasClosingBracketOnRight,
    nextLineIndex,
    nextLineText: nextLine.text,
    currentLineText: currentLine.text
  };
}

const BRACE_CHARS = { '}': true, '{': true };

function getIndent(text: string) {
  const m = text.match(/^\s*/);
  return m ? m[0] : '';
}

/**
 * 从给定位置查找语句结尾（使用 AST 解析）
 */
function findStatementEndPosition(document: vscode.TextDocument, fromLine: number, fromChar: number): vscode.Position {
  const code = document.getText();
  const parser = commandScopedParser || createAstParser();
  const result = parser.findStatementEnd(code, fromLine + 1, fromChar);
  // findStatementEnd 返回 1-based 行号，需要转换为 0-based
  return new vscode.Position(result.line - 1, result.column);
}

function getIndentIncrement(editor: vscode.TextEditor, baseIndent: string) {
  const useSpaces = editor.options.insertSpaces !== false;
  let size = 4;
  if (typeof editor.options.tabSize === 'number') {
    size = editor.options.tabSize;
  }
  // 如果基础缩进包含制表符，则继续使用制表符
  if (baseIndent.includes('\t')) {
    return '\t';
  }
  return useSpaces ? ' '.repeat(size) : '\t';
}

function getPreviousContentIndent(editor: vscode.TextEditor, fromLine: number) {
  for (let i = fromLine; i >= 0; i--) {
    const t = editor.document.lineAt(i).text;
    const trimmed = t.trim();
    if (trimmed.length === 0) continue;
    if (trimmed in BRACE_CHARS) continue;
    return getIndent(t);
  }
  return '';
}

/**
 * 验证括号是否匹配（使用 AST 局部检查）
 */
function checkBraceBalance(document: vscode.TextDocument, fromLine?: number): { ok: boolean; message?: string } {
  const code = document.getText();
  const parser = commandScopedParser || createAstParser();
  
  // 如果提供了行号，仅检查该函数作用域范围内的括号
  const isBalanced = fromLine ? parser.checkBraceBalanceInScope(code, fromLine) : parser.checkBraceBalance(code);
  if (!isBalanced) {
    return { ok: false, message: '检测到未匹配的大括号，请检查代码块完整性。' };
  }
  return { ok: true };
}

// ---------------- 选区内容校验：变量/字符串/函数名（AST 版本） ----------------

/**
 * 验证表达式是否为 PHP 变量（直接 AST 验证）
 */
function isPhpVariable(text: string): boolean {
  // 直接使用 AST 验证，优先使用命令作用域的 parser
  const parser = commandScopedParser || createAstParser();
  return parser.isValidVariable(text);
}

/**
 * 检查是否在字符串上下文中（轻量级字符扫描）
 */
function isQuotedStringContext(code: string, lineNumber: number, columnNumber: number): boolean {
  const parser = commandScopedParser || createAstParser();
  return parser.isPositionInString(code, lineNumber, columnNumber);
}

/**
 * 检查是否看起来像函数调用（直接 AST 验证）
 */
function looksLikeFunctionCall(expression: string): boolean {
  // 直接使用 AST 验证，优先使用命令作用域的 parser
  const parser = commandScopedParser || createAstParser();
  return parser.isValidFunctionCall(expression);
}

/**
 * 识别 PHP 全局函数或静态方法调用表达式
 */
function isPhpFunctionOrStaticCall(text: string): boolean {
  return looksLikeFunctionCall(text);
}

/**
 * 识別 PHP 静态属性访问表达式（直接 AST 验证）
 */
function isPhpStaticPropertyAccess(text: string): boolean {
  // 直接使用 AST 验证，优先使用命令作用域的 parser
  const parser = commandScopedParser || createAstParser();
  return parser.isValidStaticPropertyAccess(text);
}

function stripTrailingSemicolon(text: string): string {
  // 去除末尾分号（忽略末尾空白），保持表达式本体不变
  const s = text.replace(/\s+$/,'');
  return s.endsWith(';') ? s.slice(0, -1) : s;
}

function getPrintStatement(languageId: string, expression: string): string {
  const lang = (languageId || '').toLowerCase();
  if (lang === 'php') return `var_dump(${expression});exit;`;
  if (lang === 'javascript' || lang === 'typescript') return `console.log(${expression});`;
  if (lang === 'python') return `print(${expression})`;
  // 默认回退到 PHP 风格
  return `var_dump(${expression});exit;`;
}

export async function activate(context: vscode.ExtensionContext) {
  // 初始化调试管理器视图
  const cfgLang = vscode.workspace.getConfiguration('phpDebugManager').get<string>('language', 'en') as any;
  setLocale(cfgLang as any);
  const output = vscode.window.createOutputChannel(t('channel.name'));
  const t0 = Date.now();
  output.appendLine(t('startup.loading', new Date().toLocaleString()));
  const tView0 = Date.now();
  const debugManagerView = new DebugManagerView(context, output);
  output.appendLine(t('view.init.done', new Date().toLocaleString(), Date.now() - tView0));
  
  // 注册原有的dump变量命令
  const dumpVariableDisposable = vscode.commands.registerCommand('phpDebugManager.dumpVariable', () => {
    const startTime = Date.now(); // 记录开始时间
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }

    const selection = editor.selection;
    const selected = editor.document.getText(selection).trim();
    const selectedClean = stripTrailingSemicolon(selected);
    const currentLineText = editor.document.lineAt(selection.end.line).text;

    // 校验：必须选中内容
    if (selected.length === 0) {
      vscode.window.showWarningMessage(t('insert.noSelection'));
      return;
    }
    // 校验：字符串上下文
    if (isQuotedStringContext(editor.document.getText(), selection.end.line + 1, selection.end.character)) {
      vscode.window.showWarningMessage(t('insert.inString.skip'));
      return;
    }
    // 如果选区本身不含括号而其后紧跟 '('，提醒用户选中完整调用表达式
    if (!selected.includes('(') && looksLikeFunctionCall(selectedClean)) {
      vscode.window.showWarningMessage(t('insert.selectFullCall'));
      return;
    }

    // 处理打印表达式：变量、可调用表达式或静态属性访问
    let expression: string | null = null;
    if (selectedClean.startsWith('$')) {
      if (isPhpVariable(selectedClean)) expression = selectedClean;
    } else if (isPhpFunctionOrStaticCall(selectedClean)) {
      expression = selectedClean;
    } else if (isPhpStaticPropertyAccess(selectedClean)) {
      // 支持静态属性访问：如 ClassName::$property
      expression = selectedClean;
    } else {
      const prevIdx = selection.start.character - 1;
      if (prevIdx >= 0 && currentLineText[prevIdx] === '$') {
        const candidate = `$${selectedClean}`;
        if (isPhpVariable(candidate)) expression = candidate;
      }
    }

    if (!expression) {
      vscode.window.showWarningMessage(t('insert.notVariableOrCallable'));
      return;
    }

    const dumpLine = getPrintStatement(editor.document.languageId, expression);

    // 先进行括号匹配检查（使用 AST 局部检查）
    const balance = checkBraceBalance(editor.document, selection.end.line + 1);
    if (!balance.ok) {
      vscode.window.showErrorMessage(balance.message || t('brace.unbalanced'));
      return;
    }

    const analysis = analyzeBrackets(editor, selection);

    let targetPosition: vscode.Position | undefined;
    let indent = '';
    let closingBraceCase = false;

    // 特殊场景：检测选中的变量是否在数组定义内
    const code = editor.document.getText();
    // AST 使用 1-based 行号
    const parser = getCommandScopedParser();
    // 使用 AST 局部数组检查
    const arrayContext = parser.findArrayContextInScope(code, selection.end.line + 1, selection.end.character);
    
    if (arrayContext) {
      // 在数组中选中变量：插入到数组定义起始位置之前
      // arrayContext.startLine 是 1-based，转换为 0-based
      const arrayStartLineIndex = arrayContext.startLine - 1;
      
      // 插入到数组起始行之前
      const insertLineIndex = arrayStartLineIndex;
      
      // 使用数组起始行的缩进
      const arrayLine = editor.document.lineAt(arrayStartLineIndex);
      indent = getIndent(arrayLine.text);
      
      targetPosition = new vscode.Position(insertLineIndex, 0);
    } else if (analysis.nextLineIsOpeningBracket) {
      // 在"{"之后插入：定位到"{"所在行的下一行，缩进比"{"行多一个级别
      const baseIndent = getIndent(analysis.nextLineText);
      const increasedIndent = baseIndent + getIndentIncrement(editor, baseIndent);
      indent = increasedIndent;
      const insertLine = Math.min(analysis.nextLineIndex + 1, editor.document.lineCount);
      targetPosition = new vscode.Position(insertLine, 0);
    } else if (analysis.nextLineIsClosingBracket) {
      // 在下一行是右括号的场景：在该右括号行之前插入，缩进与最后一行代码齐平
      const prevContentIndent = getPreviousContentIndent(editor, selection.end.line);
      const currentIndent = getIndent(editor.document.lineAt(selection.end.line).text);
      indent = prevContentIndent || currentIndent;
      targetPosition = new vscode.Position(analysis.nextLineIndex, 0);
    } else {
      // 默认情况：直接插入到当前行的下一行
      // 这适用于：条件语句、循环语句等各种使用变量的场景
      const currentLineIndex = selection.end.line;
      const currentLine = editor.document.lineAt(currentLineIndex);
      const currentIndent = getIndent(currentLine.text);
      
      // 检查下一行是否有代码内容（非空非纯括号行）
      const nextLineIndex = currentLineIndex + 1;
      if (nextLineIndex < editor.document.lineCount) {
        const nextLine = editor.document.lineAt(nextLineIndex);
        const nextLineTrimmed = nextLine.text.trim();
        // 如果下一行有实际代码内容（非空、非纯括号），使用下一行的缩进
        if (nextLineTrimmed.length > 0 && nextLineTrimmed !== '{' && nextLineTrimmed !== '}') {
          indent = getIndent(nextLine.text);
        } else {
          indent = currentIndent;
        }
      } else {
        indent = currentIndent;
      }
      
      targetPosition = new vscode.Position(nextLineIndex, 0);
    }

    editor.edit(builder => {
      const insertText = (closingBraceCase ? '\n' : '') + indent + dumpLine + '\n';
      builder.insert(targetPosition!, insertText);
    }).then(success => {
      if (success) {
        // 记录日志到输出通道
        const insertedLine = (targetPosition?.line ?? selection.end.line) + 1;
        const endTime = Date.now(); // 记录结束时间
        const duration = endTime - startTime; // 计算耗时
        logDumpInsertion(
          editor.document.fileName,
          insertedLine,
          expression!,
          dumpLine,
          duration
        );
      }
      // 清空命令作用域内的 parser，避免下次命令执行时空有状态污染
      clearCommandScopedParser();
    });
  });

  context.subscriptions.push(dumpVariableDisposable);
  
  // 注册调试管理器相关命令
  registerDebugManagerCommands(context);
  // 注册旧ID到新命令的别名，确保与package.json菜单对齐
  registerAliasCommands(context);
  
  // 注册侧边栏提供器
  registerDebugManagerProvider(context);

  // 设置 workspaceHasPHPFiles 上下文键并监听变化
  initializeWorkspacePhpContext(context);

  // 注册额外命令
  registerExtraCommands(context);

  const tGuard0 = Date.now();
  await injectStageGuard(context, output);
  output.appendLine(t('guard.started', new Date().toLocaleString(), Date.now() - tGuard0));
  output.appendLine(t('startup.loaded', new Date().toLocaleString(), Date.now() - t0));
}

export function deactivate() {}

// 调试管理器命令注册
function registerDebugManagerCommands(context: vscode.ExtensionContext): void {
  // 这些命令已经在DebugManagerView中注册，这里只需要确保它们被激活
  // 可以在这里添加额外的命令或覆盖默认行为
}

// 调试管理器提供器注册
function registerDebugManagerProvider(context: vscode.ExtensionContext): void {
  // 侧边栏容器和视图已经在package.json中定义
  // DebugManagerView会自动处理视图的初始化
}

// 旧ID兼容：为package.json中使用的命令ID提供别名
function registerAliasCommands(context: vscode.ExtensionContext): void {
  const alias = [
    ['phpDebugManager.debugManager.refresh', 'phpDebugManager.refresh'],
    ['phpDebugManager.debugManager.clearAll', 'phpDebugManager.clearAll'],
    ['phpDebugManager.debugManager.scanNow', 'phpDebugManager.scanNow'],
    ['phpDebugManager.debugManager.export', 'phpDebugManager.exportList'],
    ['phpDebugManager.debugManager.copyContent', 'phpDebugManager.copyStatementContent'],
    ['phpDebugManager.debugManager.copyPath', 'phpDebugManager.copyFilePath'],
    ['phpDebugManager.debugManager.focus', 'phpDebugManager.focus'],
    ['phpDebugManager.debugManager.showManager', 'phpDebugManager.focus']
  ] as const;

  for (const [oldId, newId] of alias) {
    const d = vscode.commands.registerCommand(oldId, async (...args: any[]) => {
      try {
        await vscode.commands.executeCommand(newId, ...args);
      } catch (err) {
        console.error(`别名命令执行失败: ${oldId} -> ${newId}`, err);
      }
    });
    context.subscriptions.push(d);
  }
}

// 注册额外命令以复用同一逻辑
// filled 版本的书签切换复用 toggleBookmark
function registerExtraCommands(context: vscode.ExtensionContext): void {
  const d = vscode.commands.registerCommand('phpDebugManager.debugManager.toggleBookmark.filled', async (node: any) => {
    try {
      await vscode.commands.executeCommand('phpDebugManager.debugManager.toggleBookmark', node);
    } catch (err) {
      console.error('toggleBookmark.filled 执行失败', err);
    }
  });
  context.subscriptions.push(d);

  const cfgTypesCmd = vscode.commands.registerCommand('phpDebugManager.stagingGuard.configureTypes', async () => {
    const all: Array<import('./debugScanner').DebugStatement['type']> = [
      'var_dump','print_r','echo','print','var_export','printf','die','exit','error_log','trigger_error','user_error','debug_backtrace','dump','dd','xdebug_var_dump','xdebug_debug_zval','xdebug_break'
    ];
    const cfg = vscode.workspace.getConfiguration('phpDebugManager');
    const current = cfg.get<string[]>('stagingGuard.types', all) || all;
    const items = all.map(t => ({ label: t, picked: current.includes(t) }));
    const picked = await vscode.window.showQuickPick(items as any, { placeHolder: t('staging.types.pick.placeholder'), canPickMany: true });
    if (picked === undefined) return;
    const next = (picked.length > 0 ? picked.map((p: any) => p.label) : all);
    await cfg.update('stagingGuard.types', next, vscode.ConfigurationTarget.Workspace);
    vscode.window.setStatusBarMessage(t('staging.types.applied'), 2000);
  });
  context.subscriptions.push(cfgTypesCmd);
}

// 设置 workspaceHasPHPFiles 上下文键
async function setWorkspacePhpContext(): Promise<void> {
  try {
    const files = await vscode.workspace.findFiles('**/*.php', '**/{node_modules,vendor}/**', 1);
    const hasPhp = files && files.length > 0;
    await vscode.commands.executeCommand('setContext', 'workspaceHasPHPFiles', !!hasPhp);
  } catch (err) {
    console.error('计算 workspaceHasPHPFiles 失败:', err);
    await vscode.commands.executeCommand('setContext', 'workspaceHasPHPFiles', false);
  }
}

  function initializeWorkspacePhpContext(context: vscode.ExtensionContext): void {
  // 初始设置
  setWorkspacePhpContext();
  // 监听工作区变化
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.php');
  watcher.onDidCreate(() => setWorkspacePhpContext());
  watcher.onDidDelete(() => setWorkspacePhpContext());
  watcher.onDidChange(() => setWorkspacePhpContext());
  context.subscriptions.push(watcher);
  // 监听工作区文件夹变化
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => setWorkspacePhpContext()));
  }

async function injectStageGuard(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('phpDebugManager');
  const lang = cfg.get<string>('language', 'en') as any;
  setLocale(lang as any);
  const enabled = cfg.get<boolean>('stagingGuard.enabled', true);
  if (!enabled) {
    if (currentGuard) { currentGuard.stop(); currentGuard = null; }
    return;
  }
  if (currentGuard) { currentGuard.stop(); }
  currentGuard = new StagingGuard(output);
  try {
    await currentGuard.start();
  } catch (err) {
    console.error('StagingGuard 启动失败', err);
  }
  if (guardCfgListener) {
    try {
      guardCfgListener.dispose();
    } catch {}
  }
  guardCfgListener = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('phpDebugManager.language')) {
      const newLang = vscode.workspace.getConfiguration('phpDebugManager').get<string>('language', 'en') as any;
      setLocale(newLang as any);
      try {
        output.clear();
      } catch {}
      output.appendLine(t('startup.loading', new Date().toLocaleString()));
      output.appendLine(t('view.init.done', new Date().toLocaleString(), 0));
      output.appendLine(t('startup.loaded', new Date().toLocaleString(), 0));
    }
    if (e.affectsConfiguration('phpDebugManager.stagingGuard')) {
      try {
        currentGuard?.stop();
      } catch {}
      injectStageGuard(context, output);
    }
  });
  context.subscriptions.push(guardCfgListener);
}
