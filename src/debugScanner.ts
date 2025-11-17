import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

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
  private patterns: RegExp[] = [];
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
    this.patterns = this.buildPatterns();
    this.loadConfiguration();
  }

  private loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration('phpDebugManager');
    this.maxFileSize = config.get<number>('maxFileSize')!;
    this.excludePatterns = config.get<string[]>('excludePatterns')!;
    this.excludeRegexes = this.excludePatterns.map(p => this.globToRegExp(p));
  }

  private buildPatterns(): RegExp[] {
    return [
      // var_dump 语句
      /var_dump\s*\([^)]*\)\s*;?/gi,
      // print_r 语句
      /print_r\s*\([^)]*\)\s*;?/gi,
      // echo 语句
      /echo\s+[^;]*;?/gi,
      /print\s+[^;]*;?/gi,
      /var_export\s*\([^)]*\)\s*;?/gi,
      /printf\s*\([^)]*\)\s*;?/gi,
      // die/exit 语句
      /(?:die|exit)\s*(?:\([^)]*\))?\s*;?/gi,
      // error_log 语句
      /error_log\s*\([^)]*\)\s*;?/gi,
      /trigger_error\s*\([^)]*\)\s*;?/gi,
      /user_error\s*\([^)]*\)\s*;?/gi,
      // debug_backtrace 语句
      /debug_backtrace\s*\([^)]*\)\s*;?/gi,
      /dump\s*\([^)]*\)\s*;?/gi,
      /dd\s*\([^)]*\)\s*;?/gi,
      /xdebug_var_dump\s*\([^)]*\)\s*;?/gi,
      /xdebug_debug_zval\s*\([^)]*\)\s*;?/gi,
      /xdebug_break\s*;?/gi
    ];
  }

  private matchTypeFromText(text: string): DebugStatement['type'] | null {
    const t = text.toLowerCase();
    if (/^\s*dd\s*\(/.test(t)) return 'dd';
    if (/^\s*var_dump\s*\(/.test(t)) return 'var_dump';
    if (/^\s*print_r\s*\(/.test(t)) return 'print_r';
    if (/^\s*echo\s+/.test(t)) return 'echo';
    if (/^\s*print\s+/.test(t)) return 'print';
    if (/^\s*var_export\s*\(/.test(t)) return 'var_export';
    if (/^\s*printf\s*\(/.test(t)) return 'printf';
    if (/^\s*(die|exit)\b/.test(t)) return t.includes('exit') ? 'exit' : 'die';
    if (/^\s*error_log\s*\(/.test(t)) return 'error_log';
    if (/^\s*trigger_error\s*\(/.test(t)) return 'trigger_error';
    if (/^\s*user_error\s*\(/.test(t)) return 'user_error';
    if (/^\s*debug_backtrace\s*\(/.test(t)) return 'debug_backtrace';
    if (/^\s*dump\s*\(/.test(t)) return 'dump';
    if (/^\s*xdebug_var_dump\s*\(/.test(t)) return 'xdebug_var_dump';
    if (/^\s*xdebug_debug_zval\s*\(/.test(t)) return 'xdebug_debug_zval';
    if (/^\s*xdebug_break\b/.test(t)) return 'xdebug_break';
    return null;
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

    const content = await fs.promises.readFile(filePath, 'utf-8');
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const relativePath = workspaceRoot ? path.relative(workspaceRoot, filePath) : filePath;
    
    const statements: DebugStatement[] = [];
    const lines = content.split('\n');
    let inBlockComment = false;
    let inString = false;
    let stringDelimiter: '"' | "'" | null = null;
    let lastWasBackslash = false;

    // 优化：预编译正则表达式
    const compiledPatterns = this.patterns.map(pattern => new RegExp(pattern.source, pattern.flags));

    for (let i = 0; i < lines.length; i++) {
      const originalLine = lines[i];
      let lineToScan = originalLine;
      const lineNumber = i + 1;

      // 处理跨行块注释
      if (inBlockComment) {
        const endIdx = lineToScan.indexOf('*/');
        if (endIdx === -1) {
          // 整行都在注释中，跳过
          continue;
        } else {
          // 注释在本行结束，继续扫描其后的内容
          lineToScan = lineToScan.slice(endIdx + 2);
          inBlockComment = false;
        }
      }

      const trimmed = lineToScan.trim();
      // 单行注释（// 或 #）直接跳过
      if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
        continue;
      }

      // 处理本行中的块注释（可能仅部分）
      const startBlock = lineToScan.indexOf('/*');
      if (startBlock !== -1) {
        const endBlock = lineToScan.indexOf('*/', startBlock + 2);
        if (endBlock !== -1) {
          // 去掉块注释内容，仅保留注释外文本
          lineToScan = lineToScan.slice(0, startBlock) + lineToScan.slice(endBlock + 2);
        } else {
          // 块注释开始但未结束：仅扫描开始之前部分，并标记在注释中
          lineToScan = lineToScan.slice(0, startBlock);
          inBlockComment = true;
        }
      }

      // 剔除字符串字面量与内联行注释（在剔除字符串后判断），避免字符串中的关键字被误识别
      let sanitized = '';
      lastWasBackslash = false;
      for (let j = 0; j < lineToScan.length; j++) {
        const ch = lineToScan[j];

        if (inString) {
          if (ch === '\\') {
            // 记录反斜杠用于处理转义
            lastWasBackslash = !lastWasBackslash;
            // 不保留字符串内容
            continue;
          }
          // 结束字符串：同类引号且未被反斜杠转义
          if ((ch === stringDelimiter) && !lastWasBackslash) {
            inString = false;
            stringDelimiter = null;
            // 重置转义标记
            lastWasBackslash = false;
            // 不保留结束引号
            continue;
          }
          // 其他字符串内容不保留，重置转义标记
          lastWasBackslash = false;
          continue;
        } else {
          // 非字符串状态下：检测字符串开始
          if (ch === '"' || ch === '\'') {
            inString = true;
            stringDelimiter = ch as '"' | '\'';
            lastWasBackslash = false;
            // 不保留起始引号
            continue;
          }
          // 检测内联行注释开始（不在字符串中）
          if (ch === '/' && j + 1 < lineToScan.length && lineToScan[j + 1] === '/') {
            // 余下部分为注释，停止处理本行
            break;
          }
          if (ch === '#') {
            break;
          }
          // 正常代码字符保留
          sanitized += ch;
        }
      }
      lineToScan = sanitized;

      // 快速预检查，避免不必要的正则匹配
      if (!this.quickCheck(lineToScan)) {
        continue;
      }

      // 基于分号的语句分割（严格按行处理），使用映射将清理后的索引回溯到原始行
      const mapIdx: number[] = [];
      {
        // 重建 sanitized 与索引映射（上文已有 sanitized，这里再次构建映射）
        sanitized = '';
        lastWasBackslash = false;
        for (let j = 0; j < lineToScan.length; j++) {
          const ch = lineToScan[j];
          // 此处 lineToScan 已剔除注释与字符串，直接建立映射
          sanitized += ch;
          mapIdx.push(j);
        }
      }

      const segments: { text: string; startSan: number; endSan: number }[] = [];
      let segStart = 0;
      for (let k = 0; k < sanitized.length; k++) {
        if (sanitized[k] === ';') {
          const segText = sanitized.slice(segStart, k + 1);
          if (segText.trim().length > 0) {
            segments.push({ text: segText, startSan: segStart, endSan: k });
          }
          segStart = k + 1;
        }
      }
      // 最后一段（无分号结尾）忽略，仅统计以分号结束的语句，更符合“语句结束标记”要求

      const isDebugSegment = (txt: string) => this.matchTypeFromText(txt) !== null;
      const isExitOnlySegment = (txt: string) => {
        const t = txt.toLowerCase().trim();
        // 仅包含 exit/die（允许空白与可选括号）
        return /^\s*(?:exit|die)\s*(?:\([^)]*\))?\s*;\s*$/.test(t);
      };

      for (let s = 0; s < segments.length; s++) {
        const seg = segments[s];
        const next = segments[s + 1];

        // 同行组合规则：debug 段 + 下一段为纯 exit/die，则合并为一个打印语句
        if (isDebugSegment(seg.text) && next && isExitOnlySegment(next.text)) {
          const type: DebugStatement['type'] = this.getStatementType(seg.text);
          const tokenMap: Record<string, string> = {
            var_dump: 'var_dump', print_r: 'print_r', echo: 'echo', print: 'print', var_export: 'var_export', printf: 'printf',
            die: 'die', exit: 'exit', error_log: 'error_log', trigger_error: 'trigger_error', user_error: 'user_error',
            debug_backtrace: 'debug_backtrace', dump: 'dump', dd: 'dd', xdebug_var_dump: 'xdebug_var_dump', xdebug_debug_zval: 'xdebug_debug_zval', xdebug_break: 'xdebug_break'
          };
          const token = tokenMap[type] || '';
          const approx = mapIdx[seg.startSan] ?? 0;
          let startTok = token ? originalLine.indexOf(token, approx) : approx;
          if (startTok < 0 && token) startTok = originalLine.indexOf(token);
          const findEnd = (text: string, from: number): number => {
            let i = Math.max(0, from); let inStr = false; let q: '"' | '\'' | null = null; let esc = false;
            while (i < text.length) { const ch = text[i]; if (inStr) { if (ch === '\\') { esc = !esc; i++; continue; }
              if ((ch === q) && !esc) { inStr = false; q = null; esc = false; i++; continue; } esc = false; i++; continue; }
              else { if (ch === '"' || ch === '\'') { inStr = true; q = ch as '"' | '\''; esc = false; i++; continue; }
                if (ch === ';') return i + 1; i++; } }
            return text.length; };
          const end1 = findEnd(originalLine, startTok);
          const after = originalLine.slice(end1);
          const exitIdxLocal = after.search(/\b(?:exit|die)\b/);
          let finalEnd = end1;
          if (exitIdxLocal >= 0) { const exitAbs = end1 + exitIdxLocal; finalEnd = findEnd(originalLine, exitAbs); }
          const combined = originalLine.slice(startTok, finalEnd);
          const severity = this.getStatementSeverity(combined);
          statements.push(this.createDebugStatement(filePath, relativePath, lineNumber, startTok, combined, originalLine, type, severity));
          s++;
          continue;
        }

        const segType = this.getStatementType(seg.text);
        const tokenMap2: Record<string, string> = {
          var_dump: 'var_dump', print_r: 'print_r', echo: 'echo', print: 'print', var_export: 'var_export', printf: 'printf',
          die: 'die', exit: 'exit', error_log: 'error_log', trigger_error: 'trigger_error', user_error: 'user_error',
          debug_backtrace: 'debug_backtrace', dump: 'dump', dd: 'dd', xdebug_var_dump: 'xdebug_var_dump', xdebug_debug_zval: 'xdebug_debug_zval', xdebug_break: 'xdebug_break'
        };
        const tok = tokenMap2[segType] || '';
        const approxStart = mapIdx[seg.startSan] ?? 0;
        let startIdx = tok ? originalLine.indexOf(tok, approxStart) : approxStart;
        if (startIdx < 0 && tok) startIdx = originalLine.indexOf(tok);
        const findEnd2 = (text: string, from: number): number => {
          let i = Math.max(0, from); let inStr = false; let q: '"' | '\'' | null = null; let esc = false;
          while (i < text.length) { const ch = text[i]; if (inStr) { if (ch === '\\') { esc = !esc; i++; continue; }
            if ((ch === q) && !esc) { inStr = false; q = null; esc = false; i++; continue; } esc = false; i++; continue; }
            else { if (ch === '"' || ch === '\'') { inStr = true; q = ch as '"' | '\''; esc = false; i++; continue; }
              if (ch === ';') return i + 1; i++; } } return text.length; };
        const endIdx = findEnd2(originalLine, startIdx);
        const segOrig = originalLine.slice(startIdx, endIdx);
        if (this.matchTypeFromText(seg.text)) {
          statements.push(this.createDebugStatement(filePath, relativePath, lineNumber, startIdx, segOrig, originalLine, segType, this.getStatementSeverity(segOrig)));
        }
      }
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

  private createDebugStatement(
    filePath: string,
    relativePath: string,
    lineNumber: number,
    column: number,
    content: string,
    context: string,
    type: DebugStatement['type'],
    severity: DebugStatement['severity']
  ): DebugStatement {
    return {
      id: `${filePath}:${lineNumber}:${column}`,
      filePath,
      relativePath,
      lineNumber,
      column,
      content: content.trim(),
      context: context.trim(),
      type,
      severity
    };
  }

  private getStatementType(content: string): DebugStatement['type'] {
    const type = this.matchTypeFromText(content);
    return type || 'var_dump';
  }

  private async getFileHash(filePath: string, stats: fs.Stats): Promise<string> {
    // 简单的哈希：结合文件大小和修改时间
    return `${stats.size}-${stats.mtime.getTime()}`;
  }

  private quickCheck(line: string): boolean {
    return this.matchTypeFromText(line) !== null;
  }

  private getStatementSeverity(content: string): DebugStatement['severity'] {
    const lower = content.toLowerCase();
    if (lower.includes('die') || lower.includes('exit') || lower.includes('dd')) return 'error';
    if (lower.includes('error_log') || lower.includes('trigger_error') || lower.includes('user_error')) return 'warning';
    return 'info';
  }

  public startWatching(onScanComplete: (result: ScanResult) => void): void {
    this.onScanComplete = onScanComplete;
    
    // 创建文件监听器
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
    // 防抖处理，避免频繁扫描
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
