import * as phpParser from 'php-parser';
import { DebugStatement } from './debugScanner';

// 扩展 php-parser 类型定义
type PhpNode = any;
type PhpProgram = any;

/**
 * AST 节点位置信息接口
 */
interface NodeLocation {
  start: { line: number; column: number; offset: number };
  end: { line: number; column: number; offset: number };
}

/**
 * 调试语句节点信息
 */
export interface DebugStatementNode {
  type: DebugStatement['type'];
  location: NodeLocation;
  content: string;
  severity: DebugStatement['severity'];
}

/**
 * PHP AST 解析器
 * 封装 php-parser 库，提供统一的解析入口
 */
export class PhpAstParser {
  /**
   * 创建新的 PHP 解析器实例
   * 每次调用都创建新实例，避免解析错误文件后状态污染
   */
  private createParser(): phpParser.Engine {
    return new phpParser.Engine({
      parser: {
        // 启用容错模式，尽可能解析有语法错误的代码
        suppressErrors: true,
      },
      ast: {
        // 保留位置信息
        withPositions: true,
        // 保留源代码
        withSource: true,
      },
      lexer: {
        // 支持短标签
        short_tags: true,
        // 支持 ASP 风格标签
        asp_tags: false,
      },
    });
  }
  
  constructor() {
    // 构造函数保留，但不再预创建解析器实例
  }

  /**
   * 解析 PHP 代码为 AST
   * @param code PHP 源代码
   * @param filePath 文件路径（用于错误报告）
   * @returns AST 树或 null（解析失败时）
   */
  public parse(code: string, filePath: string): PhpProgram | null {
    try {
      // 如果代码不包含 PHP 标签，自动添加
      let codeToparse = code;
      if (!code.trim().startsWith('<?php') && !code.trim().startsWith('<?')) {
        codeToparse = `<?php\n${code}`;
      }
      
      // 每次解析创建新实例，避免解析错误文件后污染后续解析
      const parser = this.createParser();
      return parser.parseCode(codeToparse, filePath) as PhpProgram;
    } catch (error) {
      // 解析失败，返回 null
      return null;
    }
  }

  /**
   * 从 AST 中提取调试语句节点
   * @param ast AST 树
   * @param sourceCode 原始源代码
   * @returns 调试语句节点数组
   */
  public extractDebugStatements(ast: any, sourceCode: string): DebugStatementNode[] {
    if (!ast || !ast.children) {
      return [];
    }

    const statements: DebugStatementNode[] = [];
    const sourceLines = sourceCode.split('\n');

    // 遍历 AST 树
    this.traverseNode(ast, (node: any) => {
      const debugNode = this.identifyDebugStatement(node, sourceLines);
      if (debugNode) {
        statements.push(debugNode);
      }
    });

    // 合并同一行的调试语句与紧随的 exit/die
    return this.mergeConsecutiveStatements(statements, sourceLines);
  }

  /**
   * 合并同一行的调试语句与紧随的 exit/die
   * 例如：var_dump($x);exit; 合并为一条记录
   * @param statements 原始调试语句列表
   * @param sourceLines 源代码行数组
   * @returns 合并后的调试语句列表
   */
  private mergeConsecutiveStatements(statements: DebugStatementNode[], sourceLines: string[]): DebugStatementNode[] {
    if (statements.length < 2) {
      return statements;
    }

    // 按行号和列号排序
    const sorted = [...statements].sort((a, b) => {
      if (a.location.start.line !== b.location.start.line) {
        return a.location.start.line - b.location.start.line;
      }
      return a.location.start.column - b.location.start.column;
    });

    const result: DebugStatementNode[] = [];
    const merged = new Set<number>(); // 记录已合并的语句索引

    for (let i = 0; i < sorted.length; i++) {
      if (merged.has(i)) {
        continue;
      }

      const current = sorted[i];
      
      // 检查是否是可合并的调试函数（非 exit/die）
      if (current.type !== 'exit' && current.type !== 'die') {
        // 查找同一行后面紧跟的 exit/die
        for (let j = i + 1; j < sorted.length; j++) {
          if (merged.has(j)) {
            continue;
          }
          
          const next = sorted[j];
          
          // 检查是否在同一行
          if (next.location.start.line !== current.location.start.line) {
            break;
          }
          
          // 检查是否是 exit/die
          if (next.type === 'exit' || next.type === 'die') {
            // 合并语句
            const mergedContent = this.getMergedContent(current, next, sourceLines);
            const mergedNode: DebugStatementNode = {
              type: current.type, // 保持主调试函数类型
              location: {
                start: current.location.start,
                end: next.location.end // 扩展到 exit 结束
              },
              content: mergedContent,
              severity: 'error' // 有 exit/die 时严重级别提升为 error
            };
            result.push(mergedNode);
            merged.add(i);
            merged.add(j);
            break;
          }
        }
      }

      // 如果未被合并，添加原始语句
      if (!merged.has(i)) {
        result.push(current);
      }
    }

    return result;
  }

  /**
   * 获取合并后的内容
   * @param first 第一个语句
   * @param second 第二个语句（exit/die）
   * @param sourceLines 源代码行数组
   * @returns 合并后的内容字符串
   */
  private getMergedContent(first: DebugStatementNode, second: DebugStatementNode, sourceLines: string[]): string {
    // 都在同一行，直接提取从第一个语句开始到第二个语句结束的内容
    const line = first.location.start.line - 1;
    if (line < 0 || line >= sourceLines.length) {
      return first.content + ';' + second.content;
    }

    const sourceLine = sourceLines[line];
    const startCol = first.location.start.column;
    const endCol = second.location.end.column;

    if (startCol >= 0 && endCol <= sourceLine.length) {
      return sourceLine.substring(startCol, endCol).trim();
    }

    return first.content + ';' + second.content;
  }

  /**
   * 遍历 AST 节点（深度优先）
   * @param node 当前节点
   * @param callback 节点访问回调
   */
  private traverseNode(node: PhpNode, callback: (node: PhpNode) => void): void {
    if (!node || typeof node !== 'object') {
      return;
    }

    // 访问当前节点
    callback(node);

    // 递归遍历子节点
    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        this.traverseNode(child, callback);
      }
    }

    // 遍历节点的所有属性
    for (const key in node) {
      if (key === 'children' || key === 'loc' || key === 'kind') {
        continue;
      }
      
      const value = node[key];
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          for (const item of value) {
            this.traverseNode(item, callback);
          }
        } else {
          this.traverseNode(value, callback);
        }
      }
    }
  }

  /**
   * 识别节点是否为调试语句
   * @param node AST 节点
   * @param sourceLines 源代码行数组
   * @returns 调试语句节点信息或 null
   */
  private identifyDebugStatement(node: any, sourceLines: string[]): DebugStatementNode | null {
    if (!node || !node.kind || !node.loc) {
      return null;
    }

    const kind = node.kind;
    let debugType: DebugStatement['type'] | null = null;

    // 识别 Echo 语句
    if (kind === 'echo') {
      debugType = 'echo';
    }
    // 识别 Print 语句
    else if (kind === 'print') {
      debugType = 'print';
    }
    // 识别 Exit/Die 语句
    else if (kind === 'exit') {
      // 检查是否是 die（通过源代码判断）
      const content = this.extractNodeContent(node, sourceLines);
      debugType = content.toLowerCase().includes('die') ? 'die' : 'exit';
    }
    // 识别函数调用
    else if (kind === 'call') {
      debugType = this.identifyDebugFunctionCall(node);
    }

    if (!debugType) {
      return null;
    }

    // 提取节点内容和位置
    const content = this.extractNodeContent(node, sourceLines);
    const severity = this.determineSeverity(debugType, content);

    return {
      type: debugType,
      location: node.loc,
      content: content,
      severity: severity,
    };
  }

  /**
   * 识别调试函数调用
   * @param node Call 节点
   * @returns 调试语句类型或 null
   */
  private identifyDebugFunctionCall(node: any): DebugStatement['type'] | null {
    if (!node.what || !node.what.name) {
      return null;
    }

    const functionName = this.extractFunctionName(node.what);
    
    // 调试函数名称映射
    const debugFunctions: DebugStatement['type'][] = [
      'var_dump', 'print_r', 'var_export', 'dump', 'dd',
      'printf', 'error_log', 'trigger_error', 'user_error',
      'debug_backtrace', 'xdebug_var_dump', 'xdebug_debug_zval', 'xdebug_break'
    ];

    if (debugFunctions.includes(functionName as any)) {
      return functionName as DebugStatement['type'];
    }

    return null;
  }

  /**
   * 提取函数名称（处理命名空间）
   * @param what Call 节点的 what 属性
   * @returns 函数名称
   */
  private extractFunctionName(what: any): string {
    if (typeof what === 'string') {
      return what;
    }

    if (what.kind === 'identifier') {
      return what.name || '';
    }

    if (what.kind === 'name') {
      // 处理命名空间函数名
      if (what.name) {
        return what.name;
      }
      // 处理 parts 数组（完全限定名）
      if (Array.isArray(what.parts) && what.parts.length > 0) {
        return what.parts[what.parts.length - 1];
      }
    }

    if (what.name) {
      return what.name;
    }

    return '';
  }

  /**
   * 从节点提取源代码内容
   * @param node AST 节点
   * @param sourceLines 源代码行数组
   * @returns 节点对应的源代码文本
   */
  private extractNodeContent(node: any, sourceLines: string[]): string {
    if (!node.loc) {
      return '';
    }

    const startLine = node.loc.start.line - 1; // 转换为 0-based
    const endLine = node.loc.end.line - 1;
    const startCol = node.loc.start.column;
    const endCol = node.loc.end.column;

    if (startLine < 0 || startLine >= sourceLines.length) {
      return '';
    }

    // 单行语句
    if (startLine === endLine) {
      const line = sourceLines[startLine];
      return line.substring(startCol, endCol).trim();
    }

    // 多行语句
    const lines: string[] = [];
    for (let i = startLine; i <= endLine && i < sourceLines.length; i++) {
      if (i === startLine) {
        lines.push(sourceLines[i].substring(startCol));
      } else if (i === endLine) {
        lines.push(sourceLines[i].substring(0, endCol));
      } else {
        lines.push(sourceLines[i]);
      }
    }

    return lines.join('\n').trim();
  }

  /**
   * 确定调试语句的严重级别
   * @param type 调试语句类型
   * @param content 语句内容
   * @returns 严重级别
   */
  private determineSeverity(type: DebugStatement['type'], content: string): DebugStatement['severity'] {
    // error 级别：die, exit, dd
    if (type === 'die' || type === 'exit' || type === 'dd') {
      return 'error';
    }

    // warning 级别：错误日志类
    if (type === 'error_log' || type === 'trigger_error' || type === 'user_error') {
      return 'warning';
    }

    // info 级别：其他调试函数
    return 'info';
  }

  /**
   * 验证表达式是否为合法的 PHP 变量
   * @param expression 表达式字符串
   * @returns 是否为合法变量
   */
  public isValidVariable(expression: string): boolean {
    const trimmed = expression.trim();
    if (!trimmed) {
      return false;
    }

    try {
      // 尝试解析为 PHP 表达式
      const code = `<?php ${trimmed};`;
      const parser = this.createParser();
      const ast = parser.parseCode(code, 'expression.php') as PhpProgram;
      
      if (!ast || !ast.children || ast.children.length === 0) {
        return false;
      }

      // 检查第一个语句
      const firstStatement = ast.children[0] as PhpNode;
      if (!firstStatement || firstStatement.kind !== 'expressionstatement') {
        return false;
      }

      const expr = firstStatement.expression as PhpNode;
      const kind = expr.kind;

      // 变量类型：variable, propertylookup, offsetlookup
      return kind === 'variable' || 
             kind === 'propertylookup' || 
             kind === 'offsetlookup' ||
             kind === 'staticlookup';
    } catch {
      return false;
    }
  }

  /**
   * 验证表达式是否为合法的函数调用
   * @param expression 表达式字符串
   * @returns 是否为合法函数调用
   */
  public isValidFunctionCall(expression: string): boolean {
    const trimmed = expression.trim();
    if (!trimmed) {
      return false;
    }

    try {
      // 尝试解析为 PHP 表达式
      const code = `<?php ${trimmed};`;
      const parser = this.createParser();
      const ast = parser.parseCode(code, 'expression.php') as PhpProgram;
      
      if (!ast || !ast.children || ast.children.length === 0) {
        return false;
      }

      // 检查第一个语句
      const firstStatement = ast.children[0] as PhpNode;
      if (!firstStatement || firstStatement.kind !== 'expressionstatement') {
        return false;
      }

      const expr = firstStatement.expression as PhpNode;
      
      // 函数调用类型：call
      return expr.kind === 'call';
    } catch {
      return false;
    }
  }

  /**
   * 验证表达式是否为合法的静态属性访问（如 ClassName::$property）
   * @param expression 表达式字符串
   * @returns 是否为合法静态属性访问
   */
  public isValidStaticPropertyAccess(expression: string): boolean {
    const trimmed = expression.trim();
    if (!trimmed) {
      return false;
    }

    // 快速检查：静态属性访问必须包含 :: 和 $
    if (!trimmed.includes('::') || !trimmed.includes('$')) {
      return false;
    }

    try {
      // 尝试解析为 PHP 表达式
      const code = `<?php ${trimmed};`;
      const parser = this.createParser();
      const ast = parser.parseCode(code, 'expression.php') as PhpProgram;
      
      if (!ast || !ast.children || ast.children.length === 0) {
        return false;
      }

      // 检查第一个语句
      const firstStatement = ast.children[0] as PhpNode;
      if (!firstStatement || firstStatement.kind !== 'expressionstatement') {
        return false;
      }

      const expr = firstStatement.expression as PhpNode;
      
      // 静态属性访问类型：staticlookup
      return expr.kind === 'staticlookup';
    } catch {
      return false;
    }
  }

  /**
   * 检测给定代码中的指定位置是否在字符串内
   * @param code 完整的 PHP 代码
   * @param lineNumber 行号（1-based）
   * @param columnNumber 列号（0-based）
   * @returns 是否在字符串内
   */
  public isPositionInString(code: string, lineNumber: number, columnNumber: number): boolean {
    const lines = code.split('\n');
    if (lineNumber < 1 || lineNumber > lines.length) {
      return false;
    }

    const targetLine = lines[lineNumber - 1];
    if (columnNumber < 0 || columnNumber > targetLine.length) {
      return false;
    }

    // 从行首开始扫描到目标列
    let inString: string | null = null; // 当前字符串类型 ('"' 或 "'")
    let escaped = false;

    for (let i = 0; i < columnNumber && i < targetLine.length; i++) {
      const char = targetLine[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (inString === null && (char === '"' || char === "'")) {
        inString = char;
      } else if (inString === char) {
        inString = null;
      }
    }

    return inString !== null;
  }

  /**
   * 检测给定代码中的指定位置是否在注释内
   * @param code 完整的 PHP 代码
   * @param lineNumber 行号（1-based）
   * @param columnNumber 列号（0-based）
   * @returns 是否在注释内
   */
  public isPositionInComment(code: string, lineNumber: number, columnNumber: number): boolean {
    const lines = code.split('\n');
    if (lineNumber < 1 || lineNumber > lines.length) {
      return false;
    }

    const targetLine = lines[lineNumber - 1];
    
    // 检查单行注释
    const singleCommentIdx = targetLine.indexOf('//');
    if (singleCommentIdx !== -1 && columnNumber > singleCommentIdx) {
      // 需要验证 // 不在字符串内
      if (!this.isPositionInString(code, lineNumber, singleCommentIdx)) {
        return true;
      }
    }

    // 检查多行注释（简化版本，仅检查本行）
    const multiCommentStart = targetLine.indexOf('/*');
    const multiCommentEnd = targetLine.indexOf('*/');
    if (multiCommentStart !== -1 && !this.isPositionInString(code, lineNumber, multiCommentStart)) {
      if (multiCommentEnd === -1 || columnNumber < multiCommentEnd) {
        if (columnNumber > multiCommentStart) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 验证代码中的括号是否匹配
   * @param code 完整的 PHP 代码
   * @returns 是否匹配
   */
  public checkBraceBalance(code: string): boolean {
    const lines = code.split('\n');
    let balance = 0;

    for (let lineNum = 1; lineNum <= lines.length; lineNum++) {
      const line = lines[lineNum - 1];
      for (let col = 0; col < line.length; col++) {
        // 跳过字符串和注释内的括号
        if (this.isPositionInString(code, lineNum, col) || this.isPositionInComment(code, lineNum, col)) {
          continue;
        }

        const char = line[col];
        if (char === '{' || char === '[' || char === '(') {
          balance++;
        } else if (char === '}' || char === ']' || char === ')') {
          balance--;
          if (balance < 0) {
            return false;
          }
        }
      }
    }

    return balance === 0;
  }

  /**
   * 检测给定位置是否在数组定义内
   * @param code 完整的 PHP 代码
   * @param lineNumber 行号（1-based）
   * @param columnNumber 列号（0-based）
   * @returns 如果在数组内，返回数组定义的起始位置；否则返回 null
   */
  public findArrayContext(code: string, lineNumber: number, columnNumber: number): { startLine: number; startColumn: number } | null {
    try {
      const ast = this.parse(code, 'context.php');
      if (!ast) {
        return null;
      }

      let foundArray: { startLine: number; startColumn: number; size: number } | null = null;

      // 遍历 AST 查找包含给定位置的数组节点
      this.traverseNode(ast, (node: PhpNode) => {
        if (!node || !node.loc) return;
        
        // 检查是否是数组节点
        if (node.kind === 'array') {
          const loc = node.loc as NodeLocation;
          const startLine = loc.start.line;
          const endLine = loc.end.line;
          const startCol = loc.start.column;
          const endCol = loc.end.column;

          // 检查给定位置是否在该数组节点范围内
          const isAfterStart = lineNumber > startLine || (lineNumber === startLine && columnNumber >= startCol);
          const isBeforeEnd = lineNumber < endLine || (lineNumber === endLine && columnNumber <= endCol);

          if (isAfterStart && isBeforeEnd) {
            // 计算数组大小（用于找到最内层数组）
            const size = (endLine - startLine) * 1000 + (endCol - startCol);
            
            // 找到包含位置的最内层数组（最小的数组）
            if (!foundArray || size < foundArray.size) {
              foundArray = { startLine: startLine, startColumn: startCol, size: size };
            }
          }
        }
      });

      if (foundArray) {
        return { startLine: foundArray.startLine, startColumn: foundArray.startColumn };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 从给定位置查找最近的表达式或语句结尾
   * @param code 完整的 PHP 代码
   * @param lineNumber 起始行号（1-based）
   * @param columnNumber 起始列号（0-based）
   * @returns 结尾位置的行号和列号，返回格式 { line, column }
   */
  public findStatementEnd(code: string, lineNumber: number, columnNumber: number): { line: number; column: number } {
    const lines = code.split('\n');
    if (lineNumber < 1 || lineNumber > lines.length) {
      return { line: lineNumber, column: columnNumber };
    }

    let parenBalance = 0;
    let bracketBalance = 0;
    let braceBalance = 0;

    for (let li = lineNumber - 1; li < lines.length; li++) {
      const line = lines[li];
      const startCol = li === lineNumber - 1 ? columnNumber : 0;

      for (let ci = startCol; ci < line.length; ci++) {
        // 跳过字符串和注释
        if (this.isPositionInString(code, li + 1, ci) || this.isPositionInComment(code, li + 1, ci)) {
          continue;
        }

        const char = line[ci];

        if (char === '(') parenBalance++;
        else if (char === ')') parenBalance--;
        else if (char === '[') bracketBalance++;
        else if (char === ']') bracketBalance--;
        else if (char === '{') braceBalance++;
        else if (char === '}') braceBalance--;
        else if (char === ';' && parenBalance === 0 && bracketBalance === 0 && braceBalance === 0) {
          // 找到语句结尾
          return { line: li + 1, column: ci + 1 };
        }
      }
    }

    // 未找到分号，返回最后位置
    return { line: lines.length, column: lines[lines.length - 1].length };
  }

  /**
   * 从给定行号向上查找所在函数/方法的起始行
   * 使用 AST 遍历实现，更精确地定位函数体起点
   * @param code 完整的 PHP 代码
   * @param lineNumber 光标所在行号（1-based）
   * @returns 函数起始行号（1-based），如果不在函数内返回 1
   */
  public findFunctionScopeStart(code: string, lineNumber: number): number {
    try {
      const ast = this.parse(code, 'scope.php');
      if (!ast || !ast.children) {
        // AST 解析失败，降级为简单的正则查找
        return this.findFunctionScopeStartFallback(code, lineNumber);
      }

      let closestFunctionStart = 0;
      const lines = code.split('\n');

      // 遍历 AST 找到包含 lineNumber 的最小函数
      this.traverseNode(ast, (node: PhpNode) => {
        if (!node.loc || !node.kind) return;

        // 识别函数和方法定义
        const isFunctionNode = node.kind === 'function' || node.kind === 'method';
        if (!isFunctionNode) return;

        const startLine = node.loc.start.line;
        const endLine = node.loc.end.line;

        // 检查 lineNumber 是否在函数范围内
        if (startLine <= lineNumber && lineNumber <= endLine) {
          // 更新为包含光标的最内层函数
          if (closestFunctionStart === 0 || startLine > closestFunctionStart) {
            closestFunctionStart = startLine;
          }
        }
      });

      return closestFunctionStart > 0 ? closestFunctionStart : 1;
    } catch {
      // 解析异常，降级处理
      return this.findFunctionScopeStartFallback(code, lineNumber);
    }
  }

  /**
   * 回退方案：使用简单的行扫描查找函数起始位置
   * @param code 完整的 PHP 代码
   * @param lineNumber 光标所在行号（1-based）
   * @returns 函数起始行号
   */
  private findFunctionScopeStartFallback(code: string, lineNumber: number): number {
    const lines = code.split('\n');
    // 从当前行向上查找函数/方法关键字
    for (let i = lineNumber - 1; i >= 0; i--) {
      const line = lines[i];
      // 匹配 function、public、private、protected、static 等关键字
      if (/\b(function|public|private|protected|static|abstract|final|const)\s+/i.test(line)) {
        return i + 1; // 返回 1-based 行号
      }
    }
    return 1; // 未找到则从第一行开始
  }

  /**
   * 从给定行号查找该函数/方法的结束行
   * 使用 AST 遍历实现精确定位
   * @param code 完整的 PHP 代码
   * @param lineNumber 光标所在行号（1-based）
   * @returns 函数结束行号（1-based）
   */
  public findFunctionScopeEnd(code: string, lineNumber: number): number {
    try {
      const ast = this.parse(code, 'scope.php');
      if (!ast || !ast.children) {
        return this.findFunctionScopeEndFallback(code, lineNumber);
      }

      let closestFunctionEnd = code.split('\n').length;
      const lines = code.split('\n');

      // 遍历 AST 找到包含 lineNumber 的函数结束位置
      this.traverseNode(ast, (node: PhpNode) => {
        if (!node.loc || !node.kind) return;

        const isFunctionNode = node.kind === 'function' || node.kind === 'method';
        if (!isFunctionNode) return;

        const startLine = node.loc.start.line;
        const endLine = node.loc.end.line;

        // 检查 lineNumber 是否在函数范围内
        if (startLine <= lineNumber && lineNumber <= endLine) {
          // 找到最内层函数
          closestFunctionEnd = Math.min(closestFunctionEnd, endLine);
        }
      });

      return closestFunctionEnd > 0 ? closestFunctionEnd : lines.length;
    } catch {
      return this.findFunctionScopeEndFallback(code, lineNumber);
    }
  }

  /**
   * 回退方案：使用括号匹配查找函数结束位置
   * @param code 完整的 PHP 代码
   * @param lineNumber 光标所在行号（1-based）
   * @returns 函数结束行号
   */
  private findFunctionScopeEndFallback(code: string, lineNumber: number): number {
    const lines = code.split('\n');
    const startLine = this.findFunctionScopeStartFallback(code, lineNumber);

    let braceCount = 0;
    let foundOpeningBrace = false;

    for (let i = startLine - 1; i < lines.length; i++) {
      const line = lines[i];
      for (let j = 0; j < line.length; j++) {
        // 跳过字符串和注释
        if (this.isPositionInString(code, i + 1, j) || this.isPositionInComment(code, i + 1, j)) {
          continue;
        }

        const char = line[j];
        if (char === '{') {
          braceCount++;
          foundOpeningBrace = true;
        } else if (char === '}' && foundOpeningBrace) {
          braceCount--;
          if (braceCount === 0) {
            return i + 1; // 返回 1-based 行号
          }
        }
      }
    }

    return lines.length;
  }

  /**
   * 从局部代码范围（函数/方法内）检查括号是否匹配
   * @param code 完整的 PHP 代码
   * @param lineNumber 光标所在行号（1-based）
   * @returns 括号是否匹配
   */
  public checkBraceBalanceInScope(code: string, lineNumber: number): boolean {
    const startLine = this.findFunctionScopeStart(code, lineNumber);
    const endLine = this.findFunctionScopeEnd(code, lineNumber);

    const lines = code.split('\n');
    let balance = 0;

    for (let i = startLine - 1; i < endLine && i < lines.length; i++) {
      const line = lines[i];
      for (let j = 0; j < line.length; j++) {
        // 跳过字符串和注释
        if (this.isPositionInString(code, i + 1, j) || this.isPositionInComment(code, i + 1, j)) {
          continue;
        }

        const char = line[j];
        if (char === '{' || char === '[' || char === '(') {
          balance++;
        } else if (char === '}' || char === ']' || char === ')') {
          balance--;
          if (balance < 0) {
            return false;
          }
        }
      }
    }

    return balance === 0;
  }

  /**
   * 在局部作用域内检测给定位置是否在数组定义内
   * @param code 完整的 PHP 代码
   * @param lineNumber 光标所在行号（1-based）
   * @param columnNumber 光标所在列号（0-based）
   * @returns 如果在数组内返回数组起始位置，否则返回 null
   */
  public findArrayContextInScope(code: string, lineNumber: number, columnNumber: number): { startLine: number; startColumn: number } | null {
    try {
      const ast = this.parse(code, 'scope.php');
      if (!ast || !ast.children) {
        return null;
      }

      const scopeStart = this.findFunctionScopeStart(code, lineNumber);
      const scopeEnd = this.findFunctionScopeEnd(code, lineNumber);

      let foundArray: { startLine: number; startColumn: number; size: number } | null = null;

      // 遍历 AST 查找包含给定位置的数组节点（仅在当前作用域内）
      this.traverseNode(ast, (node: PhpNode) => {
        if (!node || !node.loc) return;

        // 检查是否是数组节点
        if (node.kind === 'array') {
          const loc = node.loc as NodeLocation;
          const startLine = loc.start.line;
          const endLine = loc.end.line;

          // 检查数组是否在当前作用域内
          if (startLine < scopeStart || endLine > scopeEnd) {
            return;
          }

          const startCol = loc.start.column;
          const endCol = loc.end.column;

          // 检查给定位置是否在该数组节点范围内
          const isAfterStart = lineNumber > startLine || (lineNumber === startLine && columnNumber >= startCol);
          const isBeforeEnd = lineNumber < endLine || (lineNumber === endLine && columnNumber <= endCol);

          if (isAfterStart && isBeforeEnd) {
            // 计算数组大小（用于找到最内层数组）
            const size = (endLine - startLine) * 1000 + (endCol - startCol);

            // 找到包含位置的最内层数组（最小的数组）
            if (!foundArray || size < foundArray.size) {
              foundArray = { startLine: startLine, startColumn: startCol, size: size };
            }
          }
        }
      });

      if (foundArray) {
        return { startLine: foundArray.startLine, startColumn: foundArray.startColumn };
      }
      return null;
    } catch {
      return null;
    }
  }
}
