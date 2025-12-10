import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PhpAstParser, DebugStatementNode } from './phpAstParser';

export interface DebugStatement {
  id: string;
  filePath: string;
  relativePath: string;
  lineNumber: number;
  column: number;
  content: string;
  context: string;
  type: 'var_dump' | 'print_r' | 'echo' | 'die' | 'exit' | 'error_log' | 'debug_backtrace' | 'print' | 'var_export' | 'dump' | 'dd' | 'trigger_error' | 'user_error' | 'printf' | 'xdebug_var_dump' | 'xdebug_debug_zval' | 'xdebug_break';
  severity: 'info' | 'warning' | 'error';
}

export interface ScanResult {
  statements: DebugStatement[];
  scannedFiles: number;
  totalStatements: number;
  errors: ScanError[];
  scanTime: number;
}

export interface ScanError {
  filePath: string;
  error: string;
  timestamp: Date;
}

export class DebugScanner {
  private astParser: PhpAstParser;
  private fileWatcher?: vscode.FileSystemWatcher;
  private onScanComplete?: (result: ScanResult) => void;
  private scanInProgress: boolean = false;
  private scanResults: Map<string, DebugStatement[]> = new Map();
  private scanErrors: ScanError[] = [];
  private disposables: vscode.Disposable[] = [];
  private fileCache: Map<string, { mtime: number; size: number; hash: string }> = new Map();
  private maxFileSize: number = 1048576; // 1MB
  private scanQueue: string[] = [];
  private excludePatterns: string[] = [];
  private excludeRegexes: RegExp[] = [];

  constructor() {
    this.astParser = new PhpAstParser();
    this.loadConfiguration();
  }

  private loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration('phpDebugManager');
    this.maxFileSize = config.get<number>('maxFileSize')!;
    this.excludePatterns = config.get<string[]>('excludePatterns')!;
    this.excludeRegexes = this.excludePatterns.map(p => this.globToRegExp(p));
  }

  public async scanWorkspace(): Promise<ScanResult> {
    const startTime = Date.now();
    if (this.scanInProgress) {
      return {
        statements: [],
        scannedFiles: 0,
        totalStatements: 0,
        errors: [],
        scanTime: 0
      };
    }
    this.scanInProgress = true;

    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('没有打开的工作区');
      }

      const statements: DebugStatement[] = [];
      const errors: ScanError[] = [];
      let scannedFiles = 0;

      // 批量处理，避免内存溢出
      const batchSize = 50;
      const filePaths: string[] = [];

      // 收集所有文件路径
      for (const folder of workspaceFolders) {
        const files = await this.collectFiles(folder.uri.fsPath);
        filePaths.push(...files);
      }

      // 分批扫描
      for (let i = 0; i < filePaths.length; i += batchSize) {
        const batch = filePaths.slice(i, i + batchSize);
        const batchStatements = await Promise.all(
          batch.map(filePath => this.scanFile(filePath))
        );
        
        // 合并结果
        for (const fileStatements of batchStatements) {
          statements.push(...fileStatements);
          scannedFiles++;
        }

        // 定期清理内存
        if (i % 200 === 0) {
          await this.cleanupMemory();
        }
      }

      const scanTime = Date.now() - startTime;
      const result: ScanResult = {
        statements: statements.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber),
        scannedFiles,
        totalStatements: statements.length,
        errors,
        scanTime
      };

      if (this.onScanComplete) {
        this.onScanComplete(result);
      }

      return result;
    } finally {
      this.scanInProgress = false;
    }
  }

  public async scanFiles(filePaths: string[]): Promise<ScanResult> {
    const startTime = Date.now();
    if (this.scanInProgress) {
      return {
        statements: [],
        scannedFiles: 0,
        totalStatements: 0,
        errors: [],
        scanTime: 0
      };
    }
    this.scanInProgress = true;

    try {
      const statements: DebugStatement[] = [];
      const errors: ScanError[] = [];
      let scannedFiles = 0;

      const batchSize = 50;
      const targets = filePaths.filter(p => p.toLowerCase().endsWith('.php')).filter(p => !this.isExcluded(p));

      for (let i = 0; i < targets.length; i += batchSize) {
        const batch = targets.slice(i, i + batchSize);
        const batchStatements = await Promise.all(
          batch.map(async fp => {
            try { return await this.scanFile(fp); } catch (e) {
              errors.push({ filePath: fp, error: e instanceof Error ? e.message : String(e), timestamp: new Date() });
              return [];
            }
          })
        );
        for (const fs of batchStatements) {
          statements.push(...fs);
          scannedFiles++;
        }
        if (i % 200 === 0) {
          await this.cleanupMemory();
        }
      }

      const scanTime = Date.now() - startTime;
      const result: ScanResult = {
        statements: statements.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber),
        scannedFiles,
        totalStatements: statements.length,
        errors,
        scanTime
      };
      if (this.onScanComplete) {
        this.onScanComplete(result);
      }
      return result;
    } finally {
      this.scanInProgress = false;
    }
  }

  private async collectFiles(dirPath: string): Promise<string[]> {
    const filePaths: string[] = [];

    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          if (this.isExcluded(fullPath) || this.shouldSkipDirectory(entry.name)) {
            continue;
          }
          const subFiles = await this.collectFiles(fullPath);
          filePaths.push(...subFiles);
        } else if (entry.isFile() && entry.name.endsWith('.php')) {
          if (this.isExcluded(fullPath)) {
            continue;
          }
          filePaths.push(fullPath);
        }
      }
    } catch (error) {
      this.scanErrors.push({
        filePath: dirPath,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date()
      });
    }

    return filePaths;
  }

  private async cleanupMemory(): Promise<void> {
    // 强制垃圾回收（如果可用）
    if ((global as any).gc) {
      (global as any).gc();
    }
    
    // 等待一小段时间让内存清理
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  private shouldSkipDirectory(dirName: string): boolean {
    const skipDirs = [
      'vendor', 'node_modules', '.git', '.svn', '.hg',
      'cache', 'temp', 'tmp', 'logs', 'storage', '.history',
      'tests', 'test', 'spec', 'docs', 'documentation'
    ];
    return skipDirs.includes(dirName.toLowerCase());
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
  }

  private globToRegExp(glob: string): RegExp {
    const escaped = glob.replace(/[.+^${}()|\[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*');
    return new RegExp('^' + escaped + '$', 'i');
  }

  public isExcluded(fullPath: string): boolean {
    const p = this.normalizePath(fullPath);
    return this.excludeRegexes.some(r => r.test(p));
  }

  public async scanFile(filePath: string): Promise<DebugStatement[]> {
    // 检查文件大小
    const stats = await fs.promises.stat(filePath);
    if (stats.size > this.maxFileSize) {
      throw new Error(`文件过大 (${stats.size} 字节)，跳过扫描`);
    }

    // 检查缓存
    const fileHash = await this.getFileHash(filePath, stats);
    const cached = this.fileCache.get(filePath);
    
    if (cached && cached.hash === fileHash) {
      // 文件未变化，使用缓存结果
      return this.scanResults.get(filePath) || [];
    }

    // 读取文件内容
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const relativePath = workspaceRoot ? path.relative(workspaceRoot, filePath) : filePath;
    
    const statements: DebugStatement[] = [];

    try {
      // 使用 AST 解析器解析 PHP 代码
      const ast = this.astParser.parse(content, filePath);
      
      if (!ast) {
        // 解析失败，记录警告但不抛出异常
        console.warn(`Failed to parse PHP file: ${filePath}`);
        return [];
      }

      // 从 AST 中提取调试语句
      const debugNodes = this.astParser.extractDebugStatements(ast, content);
      
      // 将 AST 节点转换为 DebugStatement 对象
      for (const node of debugNodes) {
        const statement = this.createDebugStatementFromNode(
          node,
          filePath,
          relativePath,
          content
        );
        statements.push(statement);
      }
    } catch (error) {
      // 解析错误，记录但不影响其他文件的扫描
      console.error(`Error scanning file ${filePath}:`, error);
    }

    // 更新缓存
    this.fileCache.set(filePath, {
      mtime: stats.mtime.getTime(),
      size: stats.size,
      hash: fileHash
    });
    this.scanResults.set(filePath, statements);

    return statements;
  }

  /**
   * 从 AST 节点创建 DebugStatement 对象
   */
  private createDebugStatementFromNode(
    node: DebugStatementNode,
    filePath: string,
    relativePath: string,
    sourceCode: string
  ): DebugStatement {
    const lineNumber = node.location.start.line;
    const column = node.location.start.column;
    
    // 获取当前行的完整内容作为 context
    const lines = sourceCode.split('\n');
    const context = lines[lineNumber - 1] || '';

    return {
      id: `${filePath}:${lineNumber}:${column}`,
      filePath,
      relativePath,
      lineNumber,
      column,
      content: node.content.trim(),
      context: context.trim(),
      type: node.type,
      severity: node.severity
    };
  }

  private async getFileHash(filePath: string, stats: fs.Stats): Promise<string> {
    // 简单的哈希：结合文件大小和修改时间
    return `${stats.size}-${stats.mtime.getTime()}`;
  }

  public startWatching(onScanComplete: (result: ScanResult) => void): void {
    this.onScanComplete = onScanComplete;
    
    // 创建文件盘听器
    this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.php');
    
    this.fileWatcher.onDidCreate(() => this.handleFileChange());
    this.fileWatcher.onDidChange(() => this.handleFileChange());
    this.fileWatcher.onDidDelete(() => this.handleFileChange());
  }

  public stopWatching(): void {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = undefined;
    }
  }

  private handleFileChange(): void {
    // 防抖处理，防止频繁扫描
    if (this.scanInProgress) {
      return;
    }

    setTimeout(async () => {
      try {
        await this.scanWorkspace();
      } catch (error) {
        console.error('文件变化扫描失败:', error);
      }
    }, 1000); // 1秒防抖
  }

  

  public dispose(): void {
    this.stopWatching();
  }

  public reloadConfiguration(): void {
    this.loadConfiguration();
  }
}
