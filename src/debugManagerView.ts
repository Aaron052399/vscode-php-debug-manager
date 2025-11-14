import * as vscode from 'vscode';
import * as path from 'path';
import { DebugDataProvider, TreeNode } from './debugDataProvider';
import { DebugStatement } from './debugScanner';
import { t, setLocale } from './i18n';

class BookmarksDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | null | void> = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private baseProvider: DebugDataProvider) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.collapsibleState || vscode.TreeItemCollapsibleState.None
    );
    item.id = element.id;
    item.iconPath = element.iconPath;
    item.contextValue = element.contextValue;
    item.resourceUri = element.resourceUri;
    item.command = element.command;
    if (element.type === 'statement') {
      item.tooltip = `文件: ${element.debugStatement?.relativePath}\n${t('line')}: ${element.lineNumber}\n内容: ${element.debugStatement?.content}`;
      item.description = t('view.bookmarks.name');
    }
    return item;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      const stmts = this.baseProvider.getBookmarkedStatements();
      const root: TreeNode = {
        id: 'bookmarks-root',
        label: `${t('view.bookmarks.name')} (${stmts.length})`,
        type: 'root',
        iconPath: new vscode.ThemeIcon('star-full'),
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
        contextValue: 'bookmarksRoot',
        children: []
      };

      const groups = new Map<string, DebugStatement[]>();
      for (const s of stmts) {
        const arr = groups.get(s.filePath) || [];
        arr.push(s);
        groups.set(s.filePath, arr);
      }
      const viewMode = this.baseProvider.getViewMode();
      if (viewMode === 'flat') {
        for (const [filePath, list] of Array.from(groups.entries()).sort(([a],[b]) => a.localeCompare(b))) {
          const fileNode: TreeNode = {
            id: `bookmark-file-${filePath}`,
            label: path.basename(filePath),
            type: 'file',
            iconPath: new vscode.ThemeIcon('file'),
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
            contextValue: 'bookmarkFile',
            resourceUri: vscode.Uri.file(filePath),
            filePath,
            parent: root,
            children: []
          };
          for (const s of list.sort((a,b)=>a.lineNumber-b.lineNumber)) {
            const node: TreeNode = {
              id: `bookmark-stmt-${s.id}`,
              label: `${t('line')} ${s.lineNumber}: ${s.content}`,
              type: 'statement',
              contextValue: 'bookmarkedStatement',
              debugStatement: s,
              filePath: s.filePath,
              lineNumber: s.lineNumber,
              bookmarked: true,
              parent: fileNode,
              command: { command: 'phpDebugManager.openStatement', title: '打开', arguments: [s] }
            };
            fileNode.children!.push(node);
          }
          root.children!.push(fileNode);
        }
      } else {
        const dirNodeMap = new Map<string, TreeNode>();
        for (const [filePath, list] of Array.from(groups.entries()).sort(([a],[b]) => a.localeCompare(b))) {
          const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath || '';
          const dirPath = path.dirname(filePath);
          const rel = ws ? path.relative(ws, dirPath) : path.dirname(list[0]?.relativePath || filePath);
          const parts = rel.split(path.sep).filter(Boolean);
          let parentNode: TreeNode = root;
          let acc = ws;
          for (const part of parts) {
            acc = acc ? path.join(acc, part) : part;
            const key = acc || part;
            let folderNode = dirNodeMap.get(key);
            if (!folderNode) {
            folderNode = {
              id: `bookmark-dir-${key}`,
              label: part,
              type: 'folder',
              iconPath: new vscode.ThemeIcon('folder'),
              collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
              contextValue: 'bookmarkFolder',
              resourceUri: ws ? vscode.Uri.file(key) : undefined,
              parent: parentNode,
              children: []
            };
              dirNodeMap.set(key, folderNode);
              parentNode.children!.push(folderNode);
            }
            parentNode = folderNode;
          }
          const fileNode: TreeNode = {
            id: `bookmark-file-${filePath}`,
            label: path.basename(filePath),
            type: 'file',
            iconPath: new vscode.ThemeIcon('file'),
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
            contextValue: 'bookmarkFile',
            resourceUri: vscode.Uri.file(filePath),
            filePath,
            parent: parentNode,
            children: []
          };
          for (const s of list.sort((a,b)=>a.lineNumber-b.lineNumber)) {
            const node: TreeNode = {
              id: `bookmark-stmt-${s.id}`,
              label: `${t('line')} ${s.lineNumber}: ${s.content}`,
              type: 'statement',
              contextValue: 'bookmarkedStatement',
              debugStatement: s,
              filePath: s.filePath,
              lineNumber: s.lineNumber,
              bookmarked: true,
              parent: fileNode,
              command: { command: 'phpDebugManager.openStatement', title: '打开', arguments: [s] }
            };
            fileNode.children!.push(node);
          }
          parentNode.children!.push(fileNode);
        }
      }

      return [root];
    }
    return Promise.resolve(element.children || []);
  }

  getParent(element: TreeNode): TreeNode | undefined {
    return element.parent;
  }
}

export class DebugManagerView {
  private treeView: vscode.TreeView<TreeNode>;
  private bookmarksView: vscode.TreeView<TreeNode>;
  private dataProvider: DebugDataProvider;
  private bookmarksProvider: BookmarksDataProvider;
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private updateQueue: (() => void)[] = [];
  private updateTimer: NodeJS.Timeout | undefined;
  private isUpdating: boolean = false;
  private context: vscode.ExtensionContext;
  private bookmarksVisible: boolean = false;
  private output!: vscode.OutputChannel;

  constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
    this.context = context;
    this.output = output;
    this.dataProvider = new DebugDataProvider(context, output);
    this.bookmarksProvider = new BookmarksDataProvider(this.dataProvider);
    
    // 创建树视图
    this.treeView = vscode.window.createTreeView('phpDebugManager', {
      treeDataProvider: this.dataProvider,
      showCollapseAll: false,
      canSelectMany: false
    });

    // 创建书签视图
    this.bookmarksView = vscode.window.createTreeView('phpDebugBookmarks', {
      treeDataProvider: this.bookmarksProvider,
      showCollapseAll: false,
      canSelectMany: false
    });

    // 创建状态栏项
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'phpDebugManager.focus';
    this.updateStatusBar();
    this.output.appendLine(t('view.init.done', new Date().toLocaleString(), 0));

    // 注册命令
    this.registerCommands(context);
    
    // 初始扫描
    this.performInitialScan();

    // 初始化书签视图显示状态
    this.bookmarksVisible = this.context.workspaceState.get<boolean>('phpDebugManager.showBookmarksView', false) || false;
    vscode.commands.executeCommand('setContext', 'phpDebugManager.showBookmarksView', this.bookmarksVisible);
    const nested = this.context.workspaceState.get<boolean>('phpDebugManager.viewModeNested', true);
    vscode.commands.executeCommand('setContext', 'phpDebugManager.viewModeNested', nested);
    this.dataProvider.setViewMode(nested ? 'nested' : 'flat');

    // 监听配置变化：excludePatterns 等更新后，重新加载并刷新
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('phpDebugManager.excludePatterns') ||
            e.affectsConfiguration('phpDebugManager.maxFileSize') ||
            e.affectsConfiguration('phpDebugManager.customPatterns')) {
          this.dataProvider.reloadScannerConfig();
          this.queueUpdate(() => this.refresh());
        }
        if (e.affectsConfiguration('phpDebugManager.language')) {
          const lang = vscode.workspace.getConfiguration('phpDebugManager').get<string>('language', 'en') as any;
          setLocale(lang as any);
          this.updateStatusBar();
          this.queueUpdate(() => this.refresh());
        }
      })
    );
  }

  private registerCommands(context: vscode.ExtensionContext): void {
    // 基本操作命令（带防抖）
    vscode.commands.registerCommand('phpDebugManager.refresh', () => {
      this.queueUpdate(() => this.refresh());
    });

    vscode.commands.registerCommand('phpDebugManager.focus', () => {
      this.treeView.reveal(undefined, { focus: true });
    });
    vscode.commands.registerCommand('phpDebugManager.debugManager.toggleExpandCollapse.expand', async () => {
      await this.expandAllTree(this.treeView, this.dataProvider);
      await vscode.commands.executeCommand('setContext', 'phpDebugManager.managerExpanded', true);
    });
    vscode.commands.registerCommand('phpDebugManager.debugManager.toggleBookmarks.show', async () => {
      this.bookmarksVisible = true;
      await this.context.workspaceState.update('phpDebugManager.showBookmarksView', true);
      await vscode.commands.executeCommand('setContext', 'phpDebugManager.showBookmarksView', true);
      this.bookmarksProvider.refresh();
      const roots = await this.bookmarksProvider.getChildren();
      if (roots && roots.length > 0) {
        await this.bookmarksView.reveal(roots[0], { focus: true, expand: 1 });
      }
    });

    vscode.commands.registerCommand('phpDebugManager.debugManager.toggleBookmarks.hide', async () => {
      this.bookmarksVisible = false;
      await this.context.workspaceState.update('phpDebugManager.showBookmarksView', false);
      await vscode.commands.executeCommand('setContext', 'phpDebugManager.showBookmarksView', false);
    });
    vscode.commands.registerCommand('phpDebugManager.debugManager.toggleExpandCollapse.collapse', async () => {
      await vscode.commands.executeCommand('workbench.actions.treeView.phpDebugManager.collapseAll');
      await vscode.commands.executeCommand('setContext', 'phpDebugManager.managerExpanded', false);
    });
    vscode.commands.registerCommand('phpDebugManager.bookmarks.toggleExpandCollapse.expand', async () => {
      await this.expandAllTree(this.bookmarksView, this.bookmarksProvider);
      await vscode.commands.executeCommand('setContext', 'phpDebugManager.bookmarksExpanded', true);
    });
    vscode.commands.registerCommand('phpDebugManager.bookmarks.toggleExpandCollapse.collapse', async () => {
      await vscode.commands.executeCommand('workbench.actions.treeView.phpDebugBookmarks.collapseAll');
      await vscode.commands.executeCommand('setContext', 'phpDebugManager.bookmarksExpanded', false);
    });

    vscode.commands.registerCommand('phpDebugManager.toggleView.nested', async () => {
      await this.context.workspaceState.update('phpDebugManager.viewModeNested', true);
      await vscode.commands.executeCommand('setContext', 'phpDebugManager.viewModeNested', true);
      this.dataProvider.setViewMode('nested');
      this.bookmarksProvider.refresh();
    });

    vscode.commands.registerCommand('phpDebugManager.toggleView.flat', async () => {
      await this.context.workspaceState.update('phpDebugManager.viewModeNested', false);
      await vscode.commands.executeCommand('setContext', 'phpDebugManager.viewModeNested', false);
      this.dataProvider.setViewMode('flat');
      this.bookmarksProvider.refresh();
    });

    // 已移除搜索功能

    // 导航命令
    vscode.commands.registerCommand('phpDebugManager.openStatement', (statement: DebugStatement) => {
      this.openStatement(statement);
    });

    // 清除命令（批量优化）
    vscode.commands.registerCommand('phpDebugManager.debugManager.clearStatement', async (node: TreeNode) => {
      if (node.type === 'statement' && node.debugStatement) {
        this.queueUpdate(() => this.clearStatement(node.debugStatement!));
        this.output.appendLine(`[Clean] Clear statement: ${node.debugStatement.filePath}:${node.debugStatement.lineNumber}`);
      }
    });

    vscode.commands.registerCommand('phpDebugManager.debugManager.clearFile', async (node: TreeNode) => {
      if (node.type === 'file' && node.filePath) {
        this.queueUpdate(() => this.clearFile(node.filePath!));
        this.output.appendLine(`[Clean] Clear file statements: ${node.filePath}`);
      }
    });

    vscode.commands.registerCommand('phpDebugManager.clearAll', async () => {
      this.queueUpdate(() => this.clearAll());
      this.output.appendLine('[Clean] Clear all debug statements');
    });

    // 书签相关命令
    vscode.commands.registerCommand('phpDebugManager.debugManager.toggleBookmark', (node: TreeNode) => {
      if (node.type === 'statement' && node.debugStatement) {
        const on = this.dataProvider.toggleBookmark(node.debugStatement);
        vscode.window.setStatusBarMessage(on ? t('bookmark.added') : t('bookmark.removed'), 1500);
        this.dataProvider.refresh();
        this.bookmarksProvider.refresh();
        this.updateStatusBar();
        this.updateViewBadges();
      }
    });

    vscode.commands.registerCommand('phpDebugManager.debugManager.clearBookmarks', () => {
      this.dataProvider.clearBookmarks();
      this.bookmarksProvider.refresh();
      vscode.window.showInformationMessage(t('bookmarks.cleared'));
    });

    // 批量操作命令
    vscode.commands.registerCommand('phpDebugManager.exportList', () => {
      this.exportStatementList();
      this.output.appendLine('[Export] Export debug statements (txt)');
    });

    vscode.commands.registerCommand('phpDebugManager.exportListAs', () => {
      this.exportStatementListAs();
      this.output.appendLine('[Export] Export debug statements (select format)');
    });

    vscode.commands.registerCommand('phpDebugManager.revealFileInManager', async (filePath: string, line?: number) => {
      await this.revealFileInManager(filePath, line);
    });

    vscode.commands.registerCommand('phpDebugManager.scanNow', () => {
      this.queueUpdate(() => this.refresh());
    });

    // 上下文菜单命令（优化）
    vscode.commands.registerCommand('phpDebugManager.copyStatementContent', (node: TreeNode) => {
      if (node.type === 'statement' && node.debugStatement) {
        this.copyToClipboard(node.debugStatement.content, t('copy.content.ok'));
      }
    });

    vscode.commands.registerCommand('phpDebugManager.copyFilePath', (node: TreeNode) => {
      if (node.filePath) {
        this.copyToClipboard(node.filePath, t('copy.path.ok'));
      }
    });

    vscode.commands.registerCommand('phpDebugManager.exclude.addDir', async (node: TreeNode) => {
      if (node.type === 'folder' && node.filePath) {
        await this.updateExcludePatterns([`${node.filePath}/**`], true);
      }
    });

    vscode.commands.registerCommand('phpDebugManager.exclude.removeDir', async (node: TreeNode) => {
      if (node.type === 'folder' && node.filePath) {
        await this.updateExcludePatterns([`${node.filePath}/**`], false);
      }
    });

    vscode.commands.registerCommand('phpDebugManager.exclude.addFile', async (node: TreeNode) => {
      if (node.type === 'file' && node.filePath) {
        await this.updateExcludePatterns([node.filePath], true);
      }
    });

    vscode.commands.registerCommand('phpDebugManager.exclude.removeFile', async (node: TreeNode) => {
      if (node.type === 'file' && node.filePath) {
        await this.updateExcludePatterns([node.filePath], false);
      }
    });

    vscode.commands.registerCommand('phpDebugManager.exclude.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'phpDebugManager.excludePatterns');
      this.output.appendLine(t('menu.open.settings.exclude'));
    });

    // 配置相关命令
    vscode.commands.registerCommand('phpDebugManager.configurePatterns', () => {
      this.configurePatterns();
      this.output.appendLine(t('menu.config.patterns'));
    });

    // 添加到订阅
    context.subscriptions.push(
      this.treeView,
      this.bookmarksView,
      this.dataProvider,
      this.statusBarItem
    );
  }

  private async performInitialScan(): Promise<void> {
    try {
      const t0 = Date.now();
      this.statusBarItem.text = t('status.scanning');
      this.statusBarItem.show();

      // 确保使用最新配置（包括排除列表）
      this.dataProvider.reloadScannerConfig();

      const result = await this.dataProvider.performScan();
      
      const dt = Date.now() - t0;
      this.statusBarItem.text = t('status.count', result.totalStatements);
      this.statusBarItem.tooltip = t('status.scan.tooltip', result.scannedFiles, result.totalStatements, result.scanTime);
      this.output.appendLine(t('log.scan.manual', result.scannedFiles, result.totalStatements, result.scanTime, dt));
      
      if (result.errors.length > 0) {
        vscode.window.showWarningMessage(t('log.scan.errors', result.errors.length), { modal: true });
        this.output.appendLine(t('log.scan.errors', result.errors.length));
      }

      // 扫描完成后触发视图刷新，确保树视图更新到最新数据
      this.dataProvider.refresh();
      this.updateViewBadges();
    } catch (error) {
      this.statusBarItem.text = '$(error)';
      this.statusBarItem.tooltip = t('error.scan.failed', String(error));
      vscode.window.showErrorMessage(t('error.scan.failed', String(error)), { modal: true });
      this.output.appendLine(t('error.scan.failed', String(error)));
    }
  }

  private queueUpdate(updateFn: () => Promise<void> | void): void {
    this.updateQueue.push(() => {
      try {
        const result = updateFn();
        if (result instanceof Promise) {
          return result;
        }
      } catch (error) {
        console.error('更新操作失败:', error);
      }
    });

    this.scheduleUpdate();
  }

  private scheduleUpdate(): void {
    if (this.updateTimer || this.isUpdating) {
      return;
    }

    this.updateTimer = setTimeout(() => {
      this.processUpdateQueue();
    }, 100); // 100ms 防抖
  }

  private async processUpdateQueue(): Promise<void> {
    if (this.isUpdating || this.updateQueue.length === 0) {
      return;
    }

    this.isUpdating = true;
    this.updateTimer = undefined;

    try {
      // 批量处理队列中的更新
      const updates = this.updateQueue.splice(0);
      
      for (const update of updates) {
        await update();
      }
    } finally {
      this.isUpdating = false;
      
      // 如果还有未处理的更新，继续处理
      if (this.updateQueue.length > 0) {
        this.scheduleUpdate();
      }
    }
  }

  private async refresh(): Promise<void> {
    await this.performInitialScan();
    this.bookmarksProvider.refresh();
  }

  // 已移除搜索框

  private async openStatement(statement: DebugStatement): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(statement.filePath);
      const lineIndex = statement.lineNumber - 1;
      const lineText = document.lineAt(lineIndex).text;
      const approxStart = Math.max(0, statement.column);

      const tokenMap: Record<string, string> = {
        var_dump: 'var_dump', print_r: 'print_r', echo: 'echo', print: 'print', var_export: 'var_export', printf: 'printf',
        die: 'die', exit: 'exit', error_log: 'error_log', trigger_error: 'trigger_error', user_error: 'user_error',
        debug_backtrace: 'debug_backtrace', dump: 'dump', dd: 'dd', xdebug_var_dump: 'xdebug_var_dump', xdebug_debug_zval: 'xdebug_debug_zval', xdebug_break: 'xdebug_break'
      };
      const token = tokenMap[statement.type] || '';
      let startIdx = approxStart;
      if (token) {
        let idx = lineText.indexOf(token, approxStart);
        if (idx < 0) idx = lineText.indexOf(token);
        if (idx >= 0) startIdx = idx;
      }

      const findEnd = (text: string, from: number): number => {
        let i = Math.max(0, from);
        let quote: string | null = null;
        let paren = 0;
        while (i < text.length) {
          const ch = text[i];
          if (quote) {
            if (ch === quote) {
              let bs = 0; let j = i - 1; while (j >= from && text[j] === '\\') { bs++; j--; }
              if (bs % 2 === 0) quote = null;
            }
            i++; continue;
          }
          if (ch === '\'' || ch === '"') { quote = ch; i++; continue; }
          if (ch === '(') { paren++; i++; continue; }
          if (ch === ')') { if (paren > 0) paren--; i++; continue; }
          if (ch === ';' && paren === 0) return i + 1;
          i++;
        }
        return text.length;
      };

      // 首个语句终点
      const end1 = findEnd(lineText, startIdx);

      // 若内容包含 exit/die 组合，则继续到第二个分号
      let finalEnd = end1;
      const comboMatch = lineText.slice(end1).match(/\b(?:exit|die)\b/);
      if (comboMatch && /;\s*(?:exit|die)\b/.test(statement.content)) {
        const afterIdx = end1 + (comboMatch.index || 0);
        finalEnd = findEnd(lineText, afterIdx);
      }

      const range = new vscode.Range(lineIndex, startIdx, lineIndex, finalEnd);
      const editor = await vscode.window.showTextDocument(document, { preview: false, selection: range });
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } catch (error) {
      vscode.window.showErrorMessage(t('open.file.failed', String(error)));
    }
  }

  private async clearStatement(statement: DebugStatement): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      t('confirm.clear.statement', statement.content),
      { modal: true },
      t('btn.confirm')
    );

    if (answer === t('btn.confirm')) {
      const success = await this.dataProvider.clearStatement(statement);
      if (success) {
        vscode.window.showInformationMessage(t('info.cleared.statement'));
        // 重新扫描并刷新视图，确保单条清除后列表即时更新
        await this.dataProvider.performScan();
        this.dataProvider.refresh();
        this.bookmarksProvider.refresh();
        this.updateStatusBar();
        this.updateViewBadges();
      } else {
        vscode.window.showErrorMessage(t('error.clear.statement'));
      }
    }
  }

  private async clearFile(filePath: string): Promise<void> {
    const statements = this.dataProvider.getStatementsByFile(filePath);
    const answer = await vscode.window.showWarningMessage(
      t('confirm.clear.file', path.basename(filePath), statements.length),
      { modal: true },
      t('btn.confirm')
    );

    if (answer === t('btn.confirm')) {
      const cleared = await this.dataProvider.clearFileStatements(filePath);
      vscode.window.showInformationMessage(t('info.cleared.file', cleared));
      // 立即重新扫描并刷新视图，避免视图显示旧缓存数据
      await this.dataProvider.performScan();
      this.dataProvider.refresh();
      this.bookmarksProvider.refresh();
      this.updateStatusBar();
      this.updateViewBadges();
    }
  }

  private async clearAll(): Promise<void> {
    const totalStatements = this.dataProvider.getAllStatements().length;
    const answer = await vscode.window.showWarningMessage(
      t('confirm.clear.all', totalStatements),
      { modal: true },
      t('btn.clear.all')
    );

    if (answer === t('btn.clear.all')) {
      const cleared = await this.dataProvider.clearAllStatements();
      vscode.window.showInformationMessage(t('info.cleared.file', cleared));
      // 全部清除后重新扫描并刷新视图
      await this.dataProvider.performScan();
      this.dataProvider.refresh();
      this.bookmarksProvider.refresh();
      this.updateStatusBar();
      this.updateViewBadges();
    }
  }

  private async exportStatementList(): Promise<void> {
    const statements = this.dataProvider.getAllStatements();
    
    if (statements.length === 0) {
      vscode.window.showInformationMessage(t('export.none'));
      return;
    }

    const content = this.generateExportContent(statements);
    
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const pad = (n: number) => String(n).padStart(2, '0');
    const d = new Date();
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const defaultNameTxt = `debug-statements-${ts}.txt`;
    const defaultPath = workspaceRoot ? path.join(workspaceRoot, defaultNameTxt) : undefined;
    const saveOptions: vscode.SaveDialogOptions = {
      filters: {
        'Text Files': ['txt'],
        'All Files': ['*']
      }
    };
    if (defaultPath) {
      saveOptions.defaultUri = vscode.Uri.file(defaultPath);
    }
    const uri = await vscode.window.showSaveDialog(saveOptions);

    if (uri) {
      try {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        vscode.window.showInformationMessage(t('export.saved', uri.fsPath));
        this.output.appendLine(`[导出] 已保存: ${uri.fsPath}`);
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (openErr) {
          vscode.window.showWarningMessage(t('export.saved.openFailed', String(openErr)), { modal: true });
          this.output.appendLine(`[导出] 文件已保存但打开失败: ${String(openErr)}`);
        }
      } catch (error) {
        vscode.window.showErrorMessage(t('export.failed', String(error)), { modal: true });
        this.output.appendLine(t('export.failed', String(error)));
      }
    }
  }

  private async exportStatementListAs(): Promise<void> {
    const statements = this.dataProvider.getAllStatements();
    if (statements.length === 0) {
      vscode.window.showInformationMessage(t('export.none'));
      return;
    }

    const config = vscode.workspace.getConfiguration('phpDebugManager');
    const defaultFormat = config.get<string>('export.defaultFormat', 'md');
    const defaultFields = config.get<string[]>('export.fields', ['file', 'line', 'type', 'text']);

    const formatPick = await vscode.window.showQuickPick([
      { label: 'CSV', description: '逗号分隔，兼容表格软件', value: 'csv' },
      { label: 'JSON', description: '结构化数据，便于程序处理', value: 'json' },
      { label: 'Markdown', description: '文档友好，便于分享', value: 'md' }
    ].map(i => ({ label: i.label, description: i.description, value: i.value })), {
      placeHolder: 'Select export format',
      canPickMany: false
    });
    if (!formatPick) {
      return;
    }
    const format = (formatPick as any).value as 'csv' | 'json' | 'md';

    const fieldItems = [
      { label: 'file', picked: defaultFields.includes('file') },
      { label: 'line', picked: defaultFields.includes('line') },
      { label: 'type', picked: defaultFields.includes('type') },
      { label: 'text', picked: defaultFields.includes('text') },
      { label: 'severity', picked: defaultFields.includes('severity') }
    ];

    const fieldsPick = await vscode.window.showQuickPick(fieldItems.map(f => ({ label: f.label, picked: f.picked })), {
      placeHolder: 'Select fields to export',
      canPickMany: true
    });
    if (fieldsPick === undefined) {
      return;
    }
    const fields = (fieldsPick.length > 0)
      ? fieldsPick.map(f => f.label)
      : defaultFields;

    const content = this.generateExportContentByFormat(format, fields, statements);

    const pad2 = (n: number) => String(n).padStart(2, '0');
    const d2 = new Date();
    const ts2 = `${d2.getFullYear()}${pad2(d2.getMonth() + 1)}${pad2(d2.getDate())}-${pad2(d2.getHours())}${pad2(d2.getMinutes())}${pad2(d2.getSeconds())}`;
    const defaultName = format === 'csv' ? `debug-statements-${ts2}.csv`
      : format === 'json' ? `debug-statements-${ts2}.json`
      : `debug-statements-${ts2}.md`;

    const filters = format === 'csv'
      ? { 'CSV Files': ['csv'], 'All Files': ['*'] }
      : format === 'json'
        ? { 'JSON Files': ['json'], 'All Files': ['*'] }
        : { 'Markdown Files': ['md'], 'All Files': ['*'] };

    const workspaceRoot2 = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const defaultPath2 = workspaceRoot2 ? path.join(workspaceRoot2, defaultName) : undefined;
    const saveOptions2: vscode.SaveDialogOptions = { filters };
    if (defaultPath2) {
      saveOptions2.defaultUri = vscode.Uri.file(defaultPath2);
    }
    const uri = await vscode.window.showSaveDialog(saveOptions2);

    if (uri) {
      try {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        vscode.window.showInformationMessage(t('export.saved', uri.fsPath));
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (openErr) {
          vscode.window.showWarningMessage(t('export.saved.openFailed', String(openErr)));
        }
      } catch (error) {
        vscode.window.showErrorMessage(t('export.failed', String(error)));
      }
    }
  }

  private generateExportContentByFormat(format: 'csv' | 'json' | 'md', fields: string[], statements: DebugStatement[]): string {
    const normFields = fields.filter(f => ['file', 'line', 'type', 'text', 'severity'].includes(f));
    const rows = statements.map(s => ({
      file: s.relativePath || s.filePath,
      line: s.lineNumber,
      type: s.type,
      text: s.content,
      severity: s.severity
    }));
    if (format === 'json') {
      const arr = rows.map(r => {
        const o: any = {};
        for (const f of normFields) o[f] = (r as any)[f];
        return o;
      });
      return JSON.stringify(arr, null, 2);
    }
    if (format === 'csv') {
      const header = normFields.join(',');
      const esc = (v: any) => {
        const s = String(v ?? '');
        if (/[",\n]/.test(s)) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      };
      const lines = [header];
      for (const r of rows) {
        lines.push(normFields.map(f => esc((r as any)[f])).join(','));
      }
      return lines.join('\n');
    }
    const mdLines: string[] = [];
    const wsFolders = vscode.workspace.workspaceFolders || [];
    const getWs = (p: string) => wsFolders.find(f => p.startsWith(f.uri.fsPath));
    const roots: Map<string, { type: 'folder'; name: string; folders: Map<string, any>; files: Map<string, DebugStatement[]> }> = new Map();
    for (const s of statements) {
      const ws = getWs(s.filePath);
      const rootName = ws ? ws.name : 'Workspace';
      if (!roots.has(rootName)) roots.set(rootName, { type: 'folder', name: rootName, folders: new Map(), files: new Map() });
      const root = roots.get(rootName)!;
      const base = ws ? ws.uri.fsPath : '';
      const rel = base ? path.relative(base, s.filePath) : (s.relativePath || s.filePath);
      const parts = rel.split(path.sep).filter(Boolean);
      const fileName = parts.pop() || rel;
      let curr = root;
      for (const part of parts) {
        let folder = curr.folders.get(part);
        if (!folder) {
          folder = { type: 'folder', name: part, folders: new Map(), files: new Map() };
          curr.folders.set(part, folder);
        }
        curr = folder;
      }
      const list = curr.files.get(fileName) || [];
      list.push(s);
      list.sort((a, b) => a.lineNumber - b.lineNumber);
      curr.files.set(fileName, list);
    }
    const renderStmts = (stmts: DebugStatement[], prefix: string): string[] => {
      const out: string[] = [];
      for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i];
        const isLast = i === stmts.length - 1;
        const conn = isLast ? '└── ' : '├── ';
        const parts: string[] = [];
        if (normFields.includes('line')) parts.push(`${t('line')} ${s.lineNumber}`);
        if (normFields.includes('type')) parts.push(s.type);
        if (normFields.includes('severity')) parts.push(s.severity);
        if (normFields.includes('text')) parts.push(s.content);
        out.push(prefix + conn + parts.join(': '));
      }
      return out;
    };
    const renderNodes = (nodes: any[], prefix: string): string[] => {
      const out: string[] = [];
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const last = i === nodes.length - 1;
        const conn = last ? '└── ' : '├── ';
        const nextPrefix = prefix + (last ? '    ' : '│   ');
        if (n.type === 'folder') {
          out.push(prefix + conn + n.name);
          const children = [...Array.from(n.folders.values()).sort((a: any, b: any) => a.name.localeCompare(b.name)), ...Array.from(n.files.entries()).sort((a: any, b: any) => a[0].localeCompare(b[0])).map(([name, list]) => ({ type: 'file', name, list }))];
          out.push(...renderNodes(children, nextPrefix));
        } else {
          out.push(prefix + conn + n.name);
          out.push(...renderStmts(n.list as DebugStatement[], nextPrefix));
        }
      }
      return out;
    };
    const all: any[] = Array.from(roots.values()).sort((a, b) => a.name.localeCompare(b.name));
    mdLines.push('```text');
    mdLines.push(...renderNodes(all, ''));
    mdLines.push('```');
    return mdLines.join('\n');
  }

  private generateExportContent(statements: DebugStatement[]): string {
    const wsFolders = vscode.workspace.workspaceFolders || [];
    const getWs = (p: string) => wsFolders.find(f => p.startsWith(f.uri.fsPath));
    const roots: Map<string, { type: 'folder'; name: string; folders: Map<string, any>; files: Map<string, DebugStatement[]> }> = new Map();
    for (const s of statements) {
      const ws = getWs(s.filePath);
      const rootName = ws ? ws.name : 'Workspace';
      if (!roots.has(rootName)) roots.set(rootName, { type: 'folder', name: rootName, folders: new Map(), files: new Map() });
      const root = roots.get(rootName)!;
      const base = ws ? ws.uri.fsPath : '';
      const rel = base ? path.relative(base, s.filePath) : (s.relativePath || s.filePath);
      const parts = rel.split(path.sep).filter(Boolean);
      const fileName = parts.pop() || rel;
      let curr = root;
      for (const part of parts) {
        let folder = curr.folders.get(part);
        if (!folder) {
          folder = { type: 'folder', name: part, folders: new Map(), files: new Map() };
          curr.folders.set(part, folder);
        }
        curr = folder;
      }
      const list = curr.files.get(fileName) || [];
      list.push(s);
      list.sort((a, b) => a.lineNumber - b.lineNumber);
      curr.files.set(fileName, list);
    }
    const render = (nodes: any[], prefix: string): string[] => {
      const out: string[] = [];
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const last = i === nodes.length - 1;
        const conn = last ? '└── ' : '├── ';
        const nextPrefix = prefix + (last ? '    ' : '│   ');
        if (n.type === 'folder') {
          out.push(prefix + conn + n.name);
          const children = [...Array.from(n.folders.values()).sort((a: any, b: any) => a.name.localeCompare(b.name)), ...Array.from(n.files.entries()).sort((a: any, b: any) => a[0].localeCompare(b[0])).map(([name, list]) => ({ type: 'file', name, list }))];
          out.push(...render(children, nextPrefix));
        } else {
          out.push(prefix + conn + n.name);
          const list = n.list as DebugStatement[];
          for (let j = 0; j < list.length; j++) {
            const s = list[j];
            const lastStmt = j === list.length - 1;
            const conn2 = lastStmt ? '└── ' : '├── ';
          out.push(nextPrefix + conn2 + `${t('line')} ${s.lineNumber}: ${s.type}: ${s.content}`);
          }
        }
      }
      return out;
    };
    const all: any[] = Array.from(roots.values()).sort((a, b) => a.name.localeCompare(b.name));
    return render(all, '').join('\n');
  }

  private async configurePatterns(): Promise<void> {
    const config = vscode.workspace.getConfiguration('phpDebugManager');
    const currentPatterns = config.get<string[]>('customPatterns', []);
    
    const newPatterns = await vscode.window.showInputBox({
      prompt: 'Enter regex for custom debug statements (comma separated)',
      value: currentPatterns.join(', '),
      placeHolder: 'e.g. var_dump\\(.*\\), print_r\\(.*\\)'
    });

    if (newPatterns !== undefined) {
      const patterns = newPatterns.split(',').map(p => p.trim()).filter(p => p);
      await config.update('customPatterns', patterns, vscode.ConfigurationTarget.Workspace);
      
      this.dataProvider.updateScannerPatterns(patterns);
      await this.refresh();
      
      vscode.window.showInformationMessage('Debug patterns updated');
    }
  }

  private copyToClipboard(text: string, message: string): void {
        vscode.env.clipboard.writeText(text).then(
            () => {
                vscode.window.showInformationMessage(message);
            },
                (error) => {
                    vscode.window.showErrorMessage(t('copy.failed', String(error.message || error)));
                }
        );
    }

  private updateStatusBar(): void {
    // 防抖更新状态栏
    if (this.updateTimer) {
      return;
    }

    setTimeout(() => {
      const scanResult = this.dataProvider.getScanResult();
      const totalStatements = scanResult?.totalStatements || 0;
      this.statusBarItem.text = t('status.count', totalStatements);
      this.statusBarItem.tooltip = t('status.tooltip', totalStatements);
      this.statusBarItem.show();
      this.updateViewBadges();
    }, 50);
  }

  private async updateExcludePatterns(paths: string[], add: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('phpDebugManager');
    const current = config.get<string[]>('excludePatterns', []) || [];
    let next: string[] = current.slice();
    if (add) {
      for (const p of paths) {
        if (!next.includes(p)) next.push(p);
      }
    } else {
      next = next.filter(x => !paths.includes(x));
    }
    await config.update('excludePatterns', next, vscode.ConfigurationTarget.Workspace);
    this.dataProvider.reloadScannerConfig();
    await this.dataProvider.performScan();
    this.dataProvider.refresh();
    this.bookmarksProvider.refresh();
    this.updateStatusBar();
    this.updateViewBadges();
    vscode.window.setStatusBarMessage(add ? t('exclude.added') : t('exclude.removed'), 2000);
  }

  public dispose(): void {
    this.dataProvider.dispose();
    this.statusBarItem.dispose();
  }

  private async expandAllTree(
    view: vscode.TreeView<TreeNode>,
    provider: { getChildren(element?: TreeNode): Thenable<TreeNode[]> }
  ): Promise<void> {
    const roots = await provider.getChildren();
    const expandNode = async (node: TreeNode): Promise<void> => {
      await view.reveal(node, { expand: true });
      const children = await provider.getChildren(node);
      for (const child of children) {
        await expandNode(child);
      }
    };
    for (const r of roots) {
      await expandNode(r);
    }
  }

  private updateViewBadges(): void {
    try {
      const totalStatements = this.dataProvider.getAllStatements().length;
      (this.treeView as any).badge = { value: totalStatements, tooltip: t('badge.debug.total.tooltip') };
      (this.bookmarksView as any).badge = undefined;
    } catch {}
  }

  private async revealFileInManager(filePath: string, line?: number): Promise<void> {
    const roots = await this.dataProvider.getChildren();
    if (!roots || roots.length === 0) return;
    const root = roots[0];
    const stack: TreeNode[] = [root];
    const getChildren = async (node: TreeNode) => this.dataProvider.getChildren(node);
    let targetFile: TreeNode | undefined;
    let targetStmt: TreeNode | undefined;
    const visited = new Set<string>();
    while (stack.length) {
      const node = stack.pop()!;
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      if (node.type === 'file' && node.filePath === filePath) {
        targetFile = node;
        const children = await getChildren(node);
        if (line !== undefined) {
          targetStmt = children.find(c => c.type === 'statement' && c.lineNumber === line);
        }
        break;
      }
      const children = await getChildren(node);
      for (const c of children) stack.push(c);
    }
    if (!targetFile) return;
    const expandAncestors = async (node: TreeNode | undefined) => {
      const path: TreeNode[] = [];
      let cur = node;
      while (cur) { path.push(cur); cur = cur.parent; }
      for (let i = path.length - 1; i >= 0; i--) {
        await this.treeView.reveal(path[i], { expand: true });
      }
    };
    await vscode.commands.executeCommand('phpDebugManager.focus');
    await expandAncestors(targetFile);
    if (targetStmt) {
      await this.treeView.reveal(targetStmt, { focus: true, expand: true });
    } else {
      await this.treeView.reveal(targetFile, { focus: true, expand: true });
    }
  }
}
