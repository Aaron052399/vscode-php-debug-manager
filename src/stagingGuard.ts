import * as vscode from 'vscode';
import * as cp from 'child_process';
import { DebugScanner, DebugStatement } from './debugScanner';
import { t } from './i18n';

type Mode = 'strict' | 'warn' | 'lenient';

export class StagingGuard {
  private scanner: DebugScanner;
  private output: vscode.OutputChannel;
  private repoDisposables: vscode.Disposable[] = [];
  private prevStaged: Map<string, Set<string>> = new Map();
  private gettingApi: Promise<any> | null = null;
  constructor(output: vscode.OutputChannel) {
    this.scanner = new DebugScanner();
    this.output = output;
  }
  async start(): Promise<void> {
    await this.attachRepositories();
  }
  stop(): void {
    for (const d of this.repoDisposables) d.dispose();
    this.repoDisposables = [];
  }
  dispose(): void {
    this.stop();
    this.output.dispose();
  }
  private async unstage(uris: vscode.Uri[]): Promise<void> {
    if (uris.length > 0) {
      try {
        await vscode.commands.executeCommand('git.unstage', uris);
        return;
      } catch {}
    }
    try {
      await vscode.commands.executeCommand('git.unstageAll');
      return;
    } catch {}
    const gitExt = vscode.extensions.getExtension('vscode.git');
    const api: any = gitExt && gitExt.isActive ? (gitExt.exports && gitExt.exports.getAPI ? gitExt.exports.getAPI(1) : null) : null;
    if (api && api.repositories && api.repositories.length > 0) {
      try {
        const byRoot = new Map<string, vscode.Uri[]>();
        for (const u of uris) {
          const repo = api.repositories.find((r: any) => u.fsPath.startsWith(r.rootUri.fsPath));
          const root = repo ? repo.rootUri.fsPath : api.repositories[0].rootUri.fsPath;
          const list = byRoot.get(root) || [];
          list.push(u);
          byRoot.set(root, list);
        }
        for (const [root, list] of byRoot) {
          const args = ['reset', '-q', 'HEAD', '--', ...list.map(u => u.fsPath)];
          await new Promise<void>((resolve) => {
            const p = cp.spawn('git', args, { cwd: root });
            p.on('exit', () => resolve());
            p.on('error', () => resolve());
          });
        }
      } catch {}
    }
  }

  private async stage(uris: vscode.Uri[]): Promise<void> {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    const api: any = gitExt && gitExt.isActive ? (gitExt.exports && gitExt.exports.getAPI ? gitExt.exports.getAPI(1) : null) : null;
    if (api && api.repositories && api.repositories.length > 0) {
      try {
        const byRoot = new Map<string, string[]>();
        for (const u of uris) {
          const repo = api.getRepository ? api.getRepository(u) : api.repositories.find((r: any) => u.fsPath.startsWith(r.rootUri.fsPath));
          const root = repo ? repo.rootUri.fsPath : api.repositories[0].rootUri.fsPath;
          const list = byRoot.get(root) || [];
          list.push(u.fsPath);
          byRoot.set(root, list);
        }
        for (const [root, list] of byRoot) {
          const repo = api.repositories.find((r: any) => r.rootUri.fsPath === root) || api.repositories[0];
          await repo.add(list);
        }
        return;
      } catch {}
    }
    // Fallback to CLI
    try {
      const byRoot = new Map<string, string[]>();
      for (const u of uris) {
        const ws = vscode.workspace.getWorkspaceFolder(u)?.uri.fsPath || (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd());
        const list = byRoot.get(ws) || [];
        list.push(u.fsPath);
        byRoot.set(ws, list);
      }
      for (const [root, list] of byRoot) {
        await new Promise<void>((resolve) => {
          const p = cp.spawn('git', ['add', '--', ...list], { cwd: root });
          p.on('exit', () => resolve());
          p.on('error', () => resolve());
        });
      }
    } catch {}
  }
  private writeLog(paths: string[], byFile: Map<string, DebugStatement[]>): void {
    const lines: string[] = [];
    lines.push('[Staging Debug Check]');
    for (const p of paths) {
      const list = byFile.get(p) || [];
      lines.push(`${p}: ${list.length}`);
    }
    this.output.appendLine(lines.join('\n'));
    this.output.show(true);
  }
  private async attachRepositories(): Promise<void> {
    const git = await this.getGitApi();
    if (!git) return;
    for (const repo of git.repositories) {
      const root = repo.rootUri.fsPath;
      const init = new Set<string>((repo.state?.indexChanges || []).map((c: any) => c.uri.fsPath));
      this.prevStaged.set(root, init);
      const d = repo.state.onDidChange(async () => {
        const current = new Set<string>((repo.state?.indexChanges || []).map((c: any) => c.uri.fsPath));
        const prev = this.prevStaged.get(root) || new Set<string>();
        const newly: string[] = [];
        for (const p of Array.from(current)) { if (!prev.has(p)) newly.push(p); }
        if (newly.length > 0) { try { this.output.appendLine(`[Guard] newly staged: ${newly.join(', ')}`); } catch {} }
        this.prevStaged.set(root, current);
        if (newly.length === 0) return;
        const cfg = vscode.workspace.getConfiguration('phpVarDumper');
        const enabled = cfg.get<boolean>('stagingGuard.enabled', true);
        if (!enabled) return;
        const mode = cfg.get<Mode>('stagingGuard.mode', 'strict');
        const result = await this.scanner.scanFiles(newly);
        if (result.totalStatements <= 0) return;
        if (mode === 'strict') {
          vscode.window.showErrorMessage(t('guard.strict.blocked'), { modal: true });
          await this.unstage(newly.map(p => vscode.Uri.file(p)));
          return;
        }
        if (mode === 'warn') {
          const count = result.totalStatements;
          await this.unstage(newly.map(p => vscode.Uri.file(p)));
          const answer = await vscode.window.showWarningMessage(t('guard.warn.title', count), { modal: true }, t('btn.continue'), t('btn.revealLocation'), t('btn.revealInManager'));
          if (answer === t('btn.revealLocation')) {
            const items = result.statements.map(s => ({ label: `${s.type} | ${s.severity} | ${t('line')} ${s.lineNumber}`, detail: s.filePath, statement: s }));
            const picked = await vscode.window.showQuickPick(items as any, { placeHolder: t('pick.reveal.placeholder'), canPickMany: false });
            if (picked) { await vscode.commands.executeCommand('phpVarDumper.openStatement', (picked as any).statement); }
          }
          if (answer === t('btn.continue')) {
            await this.stage(newly.map(p => vscode.Uri.file(p)));
          }
          if (answer === t('btn.revealInManager')) {
            const first = newly[0];
            const stmts = result.statements.filter(s => s.filePath === first);
            const ln = stmts.length > 0 ? stmts[0].lineNumber : undefined;
            await vscode.commands.executeCommand('phpVarDumper.revealFileInManager', first, ln);
          }
          return;
        }
        const byFile = new Map<string, DebugStatement[]>();
        for (const s of result.statements) { const arr = byFile.get(s.filePath) || []; arr.push(s); byFile.set(s.filePath, arr); }
        this.writeLog(newly, byFile);
      });
      this.repoDisposables.push(d);
    }
    if (git.onDidOpenRepository) {
      const d = git.onDidOpenRepository((repo: any) => {
        const root = repo.rootUri.fsPath;
        this.prevStaged.set(root, new Set<string>((repo.state?.indexChanges || []).map((c: any) => c.uri.fsPath)));
        const w = repo.state.onDidChange(async () => {
          const current = new Set<string>((repo.state?.indexChanges || []).map((c: any) => c.uri.fsPath));
          const prev = this.prevStaged.get(root) || new Set<string>();
          const newly: string[] = [];
          for (const p of Array.from(current)) { if (!prev.has(p)) newly.push(p); }
          this.prevStaged.set(root, current);
          if (newly.length === 0) return;
          const cfg = vscode.workspace.getConfiguration('phpVarDumper');
          const enabled = cfg.get<boolean>('stagingGuard.enabled', true);
          if (!enabled) return;
          const mode = cfg.get<Mode>('stagingGuard.mode', 'strict');
          const result = await this.scanner.scanFiles(newly);
          if (result.totalStatements <= 0) return;
          if (mode === 'strict') { vscode.window.showErrorMessage(t('guard.strict.blocked'), { modal: true }); await this.unstage(newly.map(p => vscode.Uri.file(p))); return; }
          if (mode === 'warn') {
            const count = result.totalStatements;
            await this.unstage(newly.map(p => vscode.Uri.file(p)));
            const answer = await vscode.window.showWarningMessage(t('guard.warn.title', count), { modal: true }, t('btn.continue'), t('btn.revealLocation'), t('btn.revealInManager'));
            if (answer === t('btn.revealLocation')) {
              const items = result.statements.map(s => ({ label: `${s.type} | ${s.severity} | ${t('line')} ${s.lineNumber}`, detail: s.filePath, statement: s }));
              const picked = await vscode.window.showQuickPick(items as any, { placeHolder: t('pick.reveal.placeholder'), canPickMany: false });
              if (picked) { await vscode.commands.executeCommand('phpVarDumper.openStatement', (picked as any).statement); }
            }
            if (answer === t('btn.continue')) {
              await this.stage(newly.map(p => vscode.Uri.file(p)));
            }
            if (answer === t('btn.revealInManager')) {
              const first = newly[0];
              const stmts = result.statements.filter(s => s.filePath === first);
              const ln = stmts.length > 0 ? stmts[0].lineNumber : undefined;
              await vscode.commands.executeCommand('phpVarDumper.revealFileInManager', first, ln);
            }
            return;
          }
          const byFile = new Map<string, DebugStatement[]>();
          for (const s of result.statements) { const arr = byFile.get(s.filePath) || []; arr.push(s); byFile.set(s.filePath, arr); }
          this.writeLog(newly, byFile);
        });
        this.repoDisposables.push(w);
      });
      this.repoDisposables.push(d);
    }
  }

  private async getGitApi(): Promise<any | null> {
    if (this.gettingApi) return this.gettingApi;
    this.gettingApi = (async () => {
      try {
        const ext = vscode.extensions.getExtension('vscode.git');
        if (!ext) return null;
        const exportsAny: any = ext.isActive ? ext.exports : await ext.activate();
        if (!exportsAny || !exportsAny.getAPI) return null;
        return exportsAny.getAPI(1);
      } catch {
        return null;
      }
    })();
    return this.gettingApi;
  }
}
