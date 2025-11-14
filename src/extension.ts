import * as vscode from 'vscode';
import { DebugManagerView } from './debugManagerView';
import { DebugScanner } from './debugScanner';
import { StagingGuard } from './stagingGuard';
import { setLocale, t } from './i18n';

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

function getIndent(text: string) {
  const m = text.match(/^\s*/);
  return m ? m[0] : '';
}

function findStatementEndPosition(document: vscode.TextDocument, fromLine: number, fromChar: number): vscode.Position {
  let li = fromLine;
  let ci = fromChar;
  let str: '"'|'\''|null = null;
  let esc = false;
  let p = 0, b = 0, c = 0;
  while (li < document.lineCount) {
    const t = document.lineAt(li).text;
    for (let i = ci; i < t.length; i++) {
      const ch = t[i];
      if (str) {
        if (ch === '\\') { esc = !esc; continue; }
        if (ch === str && !esc) { str = null; }
        esc = false; continue;
      } else {
        if (ch === '"' || ch === '\'') { str = ch as any; esc = false; continue; }
        if (ch === '(') { p++; continue; }
        if (ch === ')') { if (p>0) p--; continue; }
        if (ch === '[') { b++; continue; }
        if (ch === ']') { if (b>0) b--; continue; }
        if (ch === '{') { c++; continue; }
        if (ch === '}') { if (c>0) c--; continue; }
        if (ch === ';' && p===0 && b===0 && c===0) { return new vscode.Position(li, i+1); }
      }
    }
    li++;
    ci = 0;
  }
  return new vscode.Position(Math.min(fromLine+1, document.lineCount), 0);
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
    if (trimmed === '}' || trimmed === '{') continue;
    return getIndent(t);
  }
  return '';
}

function checkBraceBalance(document: vscode.TextDocument): { ok: boolean; message?: string } {
  let balance = 0;
  const total = document.lineCount;
  for (let i = 0; i < total; i++) {
    const text = document.lineAt(i).text;
    for (const ch of text) {
      if (ch === '{') balance++;
      else if (ch === '}') balance--;
      if (balance < 0) {
        return { ok: false, message: `在第 ${i + 1} 行出现未匹配的 '}'` };
      }
    }
  }
  if (balance !== 0) {
    return { ok: false, message: '检测到未匹配的大括号，请检查代码块完整性。' };
  }
  return { ok: true };
}

// ---------------- 选区内容校验：变量/字符串/函数名 ----------------
function scanBalanced(src: string, start: number, open: string, close: string): number {
  // 从 start 位置开始，扫描并返回匹配到的闭合符号位置，支持嵌套与引号内容
  let i = start;
  let depth = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) {
        // 处理反斜杠转义，仅在偶数个反斜杠时视为闭合
        let bs = 0;
        let j = i - 1;
        while (j >= start && src[j] === '\\') { bs++; j--; }
        if (bs % 2 === 0) quote = null;
      }
      i++;
      continue;
    }
    if (ch === '\'' || ch === '"') { quote = ch; i++; continue; }
    if (ch === open) { depth++; i++; continue; }
    if (ch === close) {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

function isPhpVariable(text: string): boolean {
  // 轻量语法分析：支持
  // - $base
  // - ->property / ->method(...)
  // - [ index ] 其中 index 支持复杂表达式与嵌套括号
  // - 任意深度的链式组合，如 $obj->a()->b[0]->c['k']

  const s = text.trim();
  if (!s.startsWith('$')) return false;

  let i = 1;
  const idMatch = s.slice(i).match(/^[a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*/);
  if (!idMatch) return false;
  i += idMatch[0].length;

  while (i < s.length) {
    // 跳过空白
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;

    if (s[i] === '[') {
      const end = scanBalanced(s, i, '[', ']');
      if (end < 0) return false;
      i = end + 1;
      continue;
    }

    if (s[i] === '-' && s[i + 1] === '>') {
      i += 2;
      while (i < s.length && /\s/.test(s[i])) i++;
      const propMatch = s.slice(i).match(/^[a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*/);
      if (!propMatch) return false;
      i += propMatch[0].length;
      while (i < s.length && /\s/.test(s[i])) i++;

      if (s[i] === '(') {
        const end = scanBalanced(s, i, '(', ')');
        if (end < 0) return false;
        i = end + 1;
      }
      continue;
    }

    // 其它字符出现则认为不属于变量表达式
    return false;
  }

  return true;
}

function isQuotedStringContext(lineText: string, selection: vscode.Selection): boolean {
  // 近似判断：选区被同一行上的引号包围，认为在字符串中
  const leftDouble = lineText.lastIndexOf('"', selection.start.character - 1);
  const leftSingle = lineText.lastIndexOf('\'', selection.start.character - 1);
  const leftQuote = Math.max(leftDouble, leftSingle);
  const rightDouble = lineText.indexOf('"', selection.end.character);
  const rightSingle = lineText.indexOf('\'', selection.end.character);
  const rightQuote = Math.min(
    rightDouble === -1 ? Infinity : rightDouble,
    rightSingle === -1 ? Infinity : rightSingle
  );
  return leftQuote !== -1 && rightQuote !== Infinity && leftQuote < selection.start.character && rightQuote > selection.end.character;
}

function looksLikeFunctionCall(lineText: string, selection: vscode.Selection): boolean {
  // 选中内容后紧跟 '(' 的情况，更可能是函数/方法名
  const after = lineText.substring(selection.end.character).trimStart();
  return after.startsWith('(');
}

// 识别 PHP 全局函数或静态方法调用表达式，如 explode(...) 或 Class::method(...)
function isPhpFunctionOrStaticCall(text: string): boolean {
  const s = text.trim();
  const idx = s.indexOf('(');
  if (idx <= 0) return false;
  // 调用者部分必须是标识符或 Class::method 链
  const callee = s.slice(0, idx).trim();
  const calleeOk = /^[a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*(?:::[a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*)*$/.test(callee);
  if (!calleeOk) return false;
  // 参数括号必须平衡
  const end = scanBalanced(s, idx, '(', ')');
  if (end < 0) return false;
  let i = end + 1;
  // 允许在调用结果后继续链式访问/索引/再次调用
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === '[') {
      const e = scanBalanced(s, i, '[', ']');
      if (e < 0) return false;
      i = e + 1; continue;
    }
    if (s[i] === '-' && s[i+1] === '>') {
      i += 2;
      while (i < s.length && /\s/.test(s[i])) i++;
      const m = s.slice(i).match(/^[a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*/);
      if (!m) return false;
      i += m[0].length;
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === '(') {
        const e2 = scanBalanced(s, i, '(', ')');
        if (e2 < 0) return false;
        i = e2 + 1;
      }
      continue;
    }
    return false;
  }
  return true;
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
  const cfgLang = vscode.workspace.getConfiguration('phpVarDumper').get<string>('language', 'en') as any;
  setLocale(cfgLang as any);
  const output = vscode.window.createOutputChannel(t('channel.name'));
  const t0 = Date.now();
  output.appendLine(t('startup.loading', new Date().toLocaleString()));
  const tView0 = Date.now();
  const debugManagerView = new DebugManagerView(context, output);
  output.appendLine(t('view.init.done', new Date().toLocaleString(), Date.now() - tView0));
  
  // 注册原有的dump变量命令
  const dumpVariableDisposable = vscode.commands.registerCommand('phpVarDumper.dumpVariable', () => {
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
    if (isQuotedStringContext(currentLineText, selection)) {
      vscode.window.showWarningMessage(t('insert.inString.skip'));
      return;
    }
    // 如果选区本身不含括号而其后紧跟 '('，提醒用户选中完整调用表达式
    if (!selected.includes('(') && looksLikeFunctionCall(currentLineText, selection)) {
      vscode.window.showWarningMessage(t('insert.selectFullCall'));
      return;
    }

    // 处理打印表达式：变量或可调用表达式
    let expression: string | null = null;
    if (selectedClean.startsWith('$')) {
      if (isPhpVariable(selectedClean)) expression = selectedClean;
    } else if (isPhpFunctionOrStaticCall(selectedClean)) {
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

    // 先进行括号匹配检查
    const balance = checkBraceBalance(editor.document);
    if (!balance.ok) {
      vscode.window.showErrorMessage(balance.message || t('brace.unbalanced'));
      return;
    }

    const analysis = analyzeBrackets(editor, selection);

    let targetPosition: vscode.Position | undefined;
    let indent = '';
    let closingBraceCase = false;

    if (analysis.nextLineIsOpeningBracket) {
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
      const currLineText = editor.document.lineAt(selection.end.line).text;
      const openIdx = currLineText.indexOf('{');
      const hasOpeningBraceOnLine = openIdx >= 0;
      let nextNonEmpty = Math.min(selection.end.line + 1, editor.document.lineCount - 1);
      while (nextNonEmpty < editor.document.lineCount && editor.document.lineAt(nextNonEmpty).text.trim().length === 0) {
        nextNonEmpty++;
      }
      const nextNonEmptyTrim = nextNonEmpty < editor.document.lineCount ? editor.document.lineAt(nextNonEmpty).text.trim() : '';
      const afterOpen = hasOpeningBraceOnLine ? currLineText.slice(openIdx + 1).trim() : '';
      if (hasOpeningBraceOnLine && afterOpen.startsWith('}')) {
        const baseIndent = getIndent(currLineText);
        const increasedIndent = baseIndent + getIndentIncrement(editor, baseIndent);
        indent = increasedIndent;
        const closeIdx = currLineText.indexOf('}', openIdx + 1);
        targetPosition = new vscode.Position(selection.end.line, Math.max(0, closeIdx));
        closingBraceCase = true;
      } else if (hasOpeningBraceOnLine && /^}\s*/.test(nextNonEmptyTrim)) {
        const baseIndent = getIndent(editor.document.lineAt(nextNonEmpty).text);
        const increasedIndent = baseIndent + getIndentIncrement(editor, baseIndent);
        indent = increasedIndent;
        targetPosition = new vscode.Position(nextNonEmpty, 0);
      } else {
      const endPos = findStatementEndPosition(editor.document, selection.end.line, selection.end.character);
      const nextLineIndex = Math.min(endPos.line + 1, editor.document.lineCount - 1);
      const prevIndent = getPreviousContentIndent(editor, endPos.line);
      indent = prevIndent || getIndent(editor.document.lineAt(endPos.line).text);
      targetPosition = new vscode.Position(endPos.line + 1, 0);
      }
    }

    editor.edit(builder => {
      const insertText = (closingBraceCase ? '\n' : '') + indent + dumpLine + '\n';
      builder.insert(targetPosition!, insertText);
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
    ['phpVarDumper.debugManager.refresh', 'phpVarDumper.refresh'],
    ['phpVarDumper.debugManager.clearAll', 'phpVarDumper.clearAll'],
    ['phpVarDumper.debugManager.scanNow', 'phpVarDumper.scanNow'],
    ['phpVarDumper.debugManager.export', 'phpVarDumper.exportList'],
    ['phpVarDumper.debugManager.copyContent', 'phpVarDumper.copyStatementContent'],
    ['phpVarDumper.debugManager.copyPath', 'phpVarDumper.copyFilePath'],
    ['phpVarDumper.debugManager.configurePatterns', 'phpVarDumper.configurePatterns'],
    ['phpVarDumper.debugManager.focus', 'phpVarDumper.focus'],
    ['phpVarDumper.debugManager.showManager', 'phpVarDumper.focus']
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
  const d = vscode.commands.registerCommand('phpVarDumper.debugManager.toggleBookmark.filled', async (node: any) => {
    try {
      await vscode.commands.executeCommand('phpVarDumper.debugManager.toggleBookmark', node);
    } catch (err) {
      console.error('toggleBookmark.filled 执行失败', err);
    }
  });
  context.subscriptions.push(d);
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
  const cfg = vscode.workspace.getConfiguration('phpVarDumper');
  const lang = cfg.get<string>('language', 'en') as any;
  setLocale(lang as any);
  const enabled = cfg.get<boolean>('stagingGuard.enabled', true);
  if (!enabled) return;
  const guard = new StagingGuard(output);
  try { await guard.start(); } catch (err) { console.error('StagingGuard 启动失败', err); }
  context.subscriptions.push({ dispose: () => guard.dispose() });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('phpVarDumper.language')) {
      const newLang = vscode.workspace.getConfiguration('phpVarDumper').get<string>('language', 'en') as any;
      setLocale(newLang as any);
      try { output.clear(); } catch {}
      output.appendLine(t('startup.loading', new Date().toLocaleString()));
      output.appendLine(t('view.init.done', new Date().toLocaleString(), 0));
      output.appendLine(t('startup.loaded', new Date().toLocaleString(), 0));
    }
    if (e.affectsConfiguration('phpVarDumper.stagingGuard')) {
      guard.dispose();
      injectStageGuard(context, output);
    }
  }));
}
