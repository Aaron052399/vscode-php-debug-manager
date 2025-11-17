import * as vscode from 'vscode';
import * as path from 'path';
import { DebugStatement, ScanResult, DebugScanner } from './debugScanner';
import { t, setLocale } from './i18n';

export interface TreeNode {
  id: string;
  label: string;
  type: 'root' | 'folder' | 'file' | 'statement';
  iconPath?: vscode.ThemeIcon;
  collapsibleState?: vscode.TreeItemCollapsibleState;
  contextValue?: string;
  resourceUri?: vscode.Uri;
  command?: vscode.Command;
  children?: TreeNode[];
  parent?: TreeNode;
  debugStatement?: DebugStatement;
  filePath?: string;
  lineNumber?: number;
  bookmarked?: boolean;
}

export class DebugDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | null | void> = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | null | void> = this._onDidChangeTreeData.event;

  private scanner: DebugScanner;
  private treeData: TreeNode[] = [];
  private lastScanResult?: ScanResult;
  private resultCache: Map<string, { data: TreeNode[]; timestamp: number }> = new Map();
  private cacheTimeout: number = 30000; // 30秒缓存
  private maxCacheSize: number = 100; // 最大缓存条目数
  private workspaceState!: vscode.Memento;
  private bookmarks: Set<string> = new Set();
  private viewMode: 'nested' | 'flat' = 'nested';
  private output?: vscode.OutputChannel;
  private disabledTypes: Set<DebugStatement['type']> = new Set();

  constructor(context: vscode.ExtensionContext, output?: vscode.OutputChannel) {
    this.scanner = new DebugScanner();
    this.scanner.startWatching(this.handleScanComplete.bind(this));
    this.workspaceState = context.workspaceState;
    const saved = this.workspaceState.get<string[]>('phpDebugManager.bookmarks', []);
    this.bookmarks = new Set(saved);
    this.output = output;
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('phpDebugManager.language')) {
        const lang = vscode.workspace.getConfiguration('phpDebugManager').get<string>('language', 'en') as any;
        setLocale(lang as any);
        this.refresh();
      }
    });
  }

  public refresh(): void {
    // 清空列表缓存以避免返回过期的树节点
    this.resultCache.clear();
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(
      element.label,
      element.collapsibleState || vscode.TreeItemCollapsibleState.None
    );

    treeItem.id = element.id;
    // 语句行不展示前置图标，其它节点按主题图标显示
    treeItem.iconPath = element.type === 'statement' ? undefined : element.iconPath;
    // 动态上下文值以便收藏按钮即时切换
    if (element.type === 'statement' && element.debugStatement) {
      const bookmarked = this.isBookmarked(element.debugStatement.id);
      treeItem.contextValue = bookmarked ? 'bookmarkedStatement' : 'debugStatement';
    } else {
      treeItem.contextValue = element.contextValue;
    }
    treeItem.resourceUri = element.resourceUri;
    treeItem.command = element.command;
    
    if (element.type === 'statement') {
      treeItem.tooltip = this.createTooltip(element);
      treeItem.description = this.createDescription(element);
    }

    return treeItem;
  }

  public getChildren(element?: TreeNode): Thenable<TreeNode[]> {
    // 使用缓存提高性能
    const cacheKey = element ? `${element.type}-${element.label}` : 'root';
    const cached = this.getCachedResult(cacheKey);
    
    if (cached) {
      return Promise.resolve(cached);
    }

    const result: TreeNode[] = !element ? this.treeData : (element.children || []);

    // 缓存结果
    this.setCachedResult(cacheKey, result);
    return Promise.resolve(result);
  }

  public getParent(element: TreeNode): TreeNode | undefined {
    return element.parent;
  }

  public async performScan(): Promise<ScanResult> {
    const result = await this.scanner.scanWorkspace();
    this.updateTreeData(result);
    return result;
  }

  private handleScanComplete(result: ScanResult): void {
    this.updateTreeData(result);
    this.refresh();
    try {
      this.output?.appendLine(t('log.scan.auto', result.scannedFiles, result.totalStatements, result.scanTime));
    } catch {}
  }

  private updateTreeData(result: ScanResult): void {
    const filtered = result.statements.filter(s => !this.disabledTypes.has(s.type));
    this.lastScanResult = {
      ...result,
      statements: filtered,
      totalStatements: filtered.length
    };
    // 数据变化时清空缓存，确保 getChildren 返回最新数据
    this.resultCache.clear();
    
    const fileGroups = new Map<string, DebugStatement[]>();
    
    this.lastScanResult.statements.forEach(statement => {
      if (!fileGroups.has(statement.filePath)) {
        fileGroups.set(statement.filePath, []);
      }
      fileGroups.get(statement.filePath)!.push(statement);
    });

    this.treeData = this.buildTreeStructure(fileGroups);
  }

  private buildTreeStructure(fileGroups: Map<string, DebugStatement[]>): TreeNode[] {
    const rootNodes: TreeNode[] = [];

    const rootNode: TreeNode = {
      id: 'debug-statements-root',
      label: `${t('view.manager.name')} (${this.lastScanResult?.totalStatements || 0})`,
      type: 'root',
      iconPath: new vscode.ThemeIcon('bug'),
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      contextValue: 'debugRoot',
      children: []
    };

    const dirNodeMap = new Map<string, TreeNode>();
    Array.from(fileGroups.entries()).sort(([a], [b]) => a.localeCompare(b)).forEach(([filePath, statements]) => {
      if (this.viewMode === 'flat') {
        const fileName = path.basename(filePath);
        const fileNode: TreeNode = {
          id: `file-${filePath}`,
          label: fileName,
          type: 'file',
          iconPath: new vscode.ThemeIcon('file'),
          collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
          contextValue: 'debugFile',
          resourceUri: vscode.Uri.file(filePath),
          filePath: filePath,
          parent: rootNode,
          children: []
        };
        statements.forEach(statement => {
          const statementNode: TreeNode = {
            id: `statement-${statement.id}`,
            label: `${t('line')} ${statement.lineNumber}: ${statement.content}`,
            type: 'statement',
            collapsibleState: vscode.TreeItemCollapsibleState.None,
            contextValue: this.isBookmarked(statement.id) ? 'bookmarkedStatement' : 'debugStatement',
            debugStatement: statement,
            filePath: statement.filePath,
            lineNumber: statement.lineNumber,
            bookmarked: this.isBookmarked(statement.id),
            parent: fileNode,
            command: { command: 'phpDebugManager.openStatement', title: '打开', arguments: [statement] }
          };
          fileNode.children!.push(statementNode);
        });
        rootNode.children!.push(fileNode);
      } else {
        const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath || '';
        const dirPath = path.dirname(filePath);
        const rel = ws ? path.relative(ws, dirPath) : path.dirname(statements[0]?.relativePath || filePath);
        const parts = rel.split(path.sep).filter(Boolean);
        let parentNode: TreeNode = rootNode;
        let acc = ws;
        for (const part of parts) {
          acc = acc ? path.join(acc, part) : part;
          const key = acc || part;
          let folderNode = dirNodeMap.get(key);
          if (!folderNode) {
            folderNode = {
              id: `dir-${key}`,
              label: part,
              type: 'folder',
              iconPath: new vscode.ThemeIcon('folder'),
              collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
              contextValue: this.scanner.isExcluded(key) ? 'excludedFolder' : 'debugFolder',
              resourceUri: ws ? vscode.Uri.file(key) : undefined,
              filePath: key,
              parent: parentNode,
              children: []
            };
            dirNodeMap.set(key, folderNode);
            parentNode.children!.push(folderNode);
          }
          parentNode = folderNode;
        }
        const fileName = path.basename(filePath);
      const fileNode: TreeNode = {
        id: `file-${filePath}`,
        label: fileName,
        type: 'file',
        iconPath: new vscode.ThemeIcon('file'),
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        contextValue: this.scanner.isExcluded(filePath) ? 'excludedFile' : 'debugFile',
        resourceUri: vscode.Uri.file(filePath),
        filePath: filePath,
        parent: parentNode,
        children: []
      };
        statements.forEach(statement => {
          const statementNode: TreeNode = {
            id: `statement-${statement.id}`,
            label: `${t('line')} ${statement.lineNumber}: ${statement.content}`,
            type: 'statement',
            collapsibleState: vscode.TreeItemCollapsibleState.None,
            contextValue: this.isBookmarked(statement.id) ? 'bookmarkedStatement' : 'debugStatement',
            debugStatement: statement,
            filePath: statement.filePath,
            lineNumber: statement.lineNumber,
            bookmarked: this.isBookmarked(statement.id),
            parent: fileNode,
            command: { command: 'phpDebugManager.openStatement', title: '打开', arguments: [statement] }
          };
          fileNode.children!.push(statementNode);
        });
        parentNode.children!.push(fileNode);
      }
    });

    rootNodes.push(rootNode);
    return rootNodes;
  }

  private getStatementIcon(statement: DebugStatement): vscode.ThemeIcon {
    // 优先显示书签图标
    if (this.isBookmarked(statement.id)) {
      return new vscode.ThemeIcon('star-full');
    }
    switch (statement.type) {
      case 'var_dump':
        return new vscode.ThemeIcon('debug-alt', new vscode.ThemeColor('debugIcon.breakpointForeground'));
      case 'print_r':
        return new vscode.ThemeIcon('debug-alt', new vscode.ThemeColor('debugIcon.breakpointUnverifiedForeground'));
      case 'echo':
        return new vscode.ThemeIcon('output', new vscode.ThemeColor('terminal.ansiGreen'));
      case 'die':
      case 'exit':
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      case 'error_log':
        return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
      case 'debug_backtrace':
        return new vscode.ThemeIcon('debug-stackframe', new vscode.ThemeColor('debugIcon.breakpointCurrentStackframeForeground'));
      default:
        return new vscode.ThemeIcon('debug-alt');
    }
  }

  private createTooltip(element: TreeNode): string {
    const statement = element.debugStatement!;
    return [
      `文件: ${statement.relativePath}`,
      `${t('line')}: ${statement.lineNumber}`,
      `类型: ${statement.type}`,
      `内容: ${statement.content}`,
      `上下文: ${statement.context}`,
      `严重程度: ${statement.severity}`
    ].join('\n');
  }

  private createDescription(element: TreeNode): string {
    const statement = element.debugStatement!;
    return `${statement.type} | ${statement.severity}`;
  }

  private getCachedResult(key: string): TreeNode[] | null {
    const cached = this.resultCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }
    return null;
  }

  private setCachedResult(key: string, data: TreeNode[]): void {
    // 清理过期缓存
    this.cleanupCache();
    
    this.resultCache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  private cleanupCache(): void {
    const now = Date.now();
    
    // 移除过期缓存
    for (const [key, cached] of this.resultCache.entries()) {
      if (now - cached.timestamp > this.cacheTimeout) {
        this.resultCache.delete(key);
      }
    }
    
    // 限制缓存大小
    if (this.resultCache.size > this.maxCacheSize) {
      const entries = Array.from(this.resultCache.entries());
      const toRemove = entries.slice(0, entries.length - this.maxCacheSize);
      toRemove.forEach(([key]) => this.resultCache.delete(key));
    }
  }

  private truncateContent(content: string, maxLength: number = 50): string {
    // 优化：避免重复创建字符串
    if (content.length <= maxLength) {
      return content;
    }
    return content.substring(0, maxLength) + '...';
  }

  // 已移除过滤功能

  public getAllStatements(): DebugStatement[] {
    return this.lastScanResult?.statements || [];
  }

  public getStatementsByFile(filePath: string): DebugStatement[] {
    return this.getAllStatements().filter(s => s.filePath === filePath);
  }

  public getScanResult(): ScanResult | undefined {
    return this.lastScanResult;
  }

  public async clearStatement(statement: DebugStatement): Promise<boolean> {
    // 书签保护：被标记为书签的语句不允许被一键清理删除
    if (this.isBookmarked(statement.id)) {
      return false;
    }
    try {
      const document = await vscode.workspace.openTextDocument(statement.filePath);
      const editor = await vscode.window.showTextDocument(document);
      
      const lineIdx = statement.lineNumber - 1;
      const line = document.lineAt(lineIdx);
      // 整行删除：直接移除该行（包含行尾换行）
      await editor.edit(editBuilder => {
        editBuilder.delete(line.rangeIncludingLineBreak);
      });
      await document.save();
      
      // 同步移除可能存在的书签记录，保持一致性
      if (this.bookmarks.delete(statement.id)) {
        this.workspaceState.update('phpDebugManager.bookmarks', Array.from(this.bookmarks));
      }

      return true;
    } catch (error) {
      console.error('清除调试语句失败:', error);
      return false;
    }
  }

  public async clearFileStatements(filePath: string): Promise<number> {
    // 为了避免同一行多个语句删除时的列索引偏移，
    // 按行号和列降序处理，使得后面的字符删除不会影响前面的定位
    const statements = this.getStatementsByFile(filePath)
      // 跳过书签语句
      .filter(s => !this.isBookmarked(s.id))
      .slice()
      .sort((a, b) => {
        if (a.lineNumber !== b.lineNumber) return b.lineNumber - a.lineNumber;
        return b.column - a.column;
      });
    let cleared = 0;
    
    for (const statement of statements) {
      if (await this.clearStatement(statement)) {
        cleared++;
      }
    }
    
    if (cleared > 0) {
      // 刷新书签、缓存与视图
      this.workspaceState.update('phpDebugManager.bookmarks', Array.from(this.bookmarks));
      this.resultCache.clear();
      this.refresh();
    }

    return cleared;
  }

  public async clearAllStatements(): Promise<number> {
    // 按文件分组并在每个文件内按行号降序、列降序处理
    const byFile = new Map<string, DebugStatement[]>();
    for (const s of this.getAllStatements()) {
      // 跳过书签语句，避免被一键清理删除
      if (this.isBookmarked(s.id)) continue;
      const arr = byFile.get(s.filePath) || [];
      arr.push(s);
      byFile.set(s.filePath, arr);
    }

    let cleared = 0;
    for (const [, list] of byFile) {
      list.sort((a, b) => {
        if (a.lineNumber !== b.lineNumber) return b.lineNumber - a.lineNumber;
        return b.column - a.column;
      });
      for (const s of list) {
        if (await this.clearStatement(s)) {
          cleared++;
        }
      }
    }

    if (cleared > 0) {
      // 刷新书签、缓存与视图
      this.workspaceState.update('phpDebugManager.bookmarks', Array.from(this.bookmarks));
      this.resultCache.clear();
      this.refresh();
    }

    return cleared;
  }

  // ---------------- 书签相关 ----------------
  public toggleBookmark(statement: DebugStatement): boolean {
    const id = statement.id;
    if (this.bookmarks.has(id)) {
      this.bookmarks.delete(id);
    } else {
      this.bookmarks.add(id);
    }
    this.workspaceState.update('phpDebugManager.bookmarks', Array.from(this.bookmarks));
    // 数据变化时刷新视图与缓存
    this.resultCache.clear();
    this.refresh();
    return this.bookmarks.has(id);
  }

  public isBookmarked(id: string): boolean {
    return this.bookmarks.has(id);
  }

  public getBookmarkedStatements(): DebugStatement[] {
    const ids = this.bookmarks;
    return this.getAllStatements().filter(s => ids.has(s.id));
  }

  public clearBookmarks(): void {
    this.bookmarks.clear();
    this.workspaceState.update('phpDebugManager.bookmarks', []);
    this.resultCache.clear();
    this.refresh();
  }

  public reloadScannerConfig(): void {
    if ((this.scanner as any).reloadConfiguration) {
      (this.scanner as any).reloadConfiguration();
    }
  }

  public setDisabledTypes(types: DebugStatement['type'][]): void {
    this.disabledTypes = new Set(types);
    if (this.lastScanResult) {
      this.updateTreeData(this.lastScanResult);
      this.refresh();
    }
  }

  public setViewMode(mode: 'nested' | 'flat'): void {
    this.viewMode = mode;
    if (this.lastScanResult) {
      this.updateTreeData(this.lastScanResult);
    }
    this.refresh();
  }

  public getViewMode(): 'nested' | 'flat' {
    return this.viewMode;
  }

  public dispose(): void {
    this.scanner.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
