import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { WorktreeManager, type Worktree } from './worktree-manager.js';

/** How each supported agent CLI accepts a one-shot prompt. */
export const AGENTS: Record<string, { cmd: string; args: (prompt: string) => string[] }> = {
  'claude-code': { cmd: 'claude', args: (p) => ['-p', p] },
  codex: { cmd: 'codex', args: (p) => ['exec', p] },
  opencode: { cmd: 'opencode', args: (p) => ['run', p] },
  aider: { cmd: 'aider', args: (p) => ['--yes', '--message', p] },
  goose: { cmd: 'goose', args: (p) => ['run', '-t', p] },
};

export type AgentEvent =
  | { type: 'start'; worktree: Worktree }
  | { type: 'data'; worktree: Worktree; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'exit'; worktree: Worktree; code: number | null; durationMs: number };

export class Orchestrator extends EventEmitter {
  private procs = new Map<string, ChildProcess>();
  readonly manager: WorktreeManager;

  constructor(repo: string, private registry = AGENTS) {
    super();
    this.manager = new WorktreeManager(repo);
  }

  /** Fan one prompt out to every agent, each in its own worktree. */
  async fanout(agents: string[], prompt: string): Promise<Worktree[]> {
    const unknown = agents.filter((a) => !this.registry[a]);
    if (unknown.length) throw new Error(`Unknown agent(s): ${unknown.join(', ')}`);
    const worktrees = await Promise.all(agents.map((a) => this.manager.create(a, prompt)));
    worktrees.forEach((wt) => this.launch(wt, prompt));
    return worktrees;
  }

  private launch(wt: Worktree, prompt: string) {
    const spec = this.registry[wt.agent];
    const started = Date.now();
    const child = spawn(spec.cmd, spec.args(prompt), { cwd: wt.dir, env: process.env });
    this.procs.set(wt.branch, child);
    this.emit('event', { type: 'start', worktree: wt } satisfies AgentEvent);
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (b: Buffer) =>
        this.emit('event', { type: 'data', worktree: wt, stream, chunk: b.toString() } satisfies AgentEvent));
    }
    const finish = (code: number | null, err?: Error) => {
      if (!this.procs.delete(wt.branch)) return;
      if (err) this.emit('event', { type: 'data', worktree: wt, stream: 'stderr', chunk: `${err.message}\n` } satisfies AgentEvent);
      this.emit('event', { type: 'exit', worktree: wt, code, durationMs: Date.now() - started } satisfies AgentEvent);
    };
    child.on('error', (e) => finish(127, e));
    child.on('close', (code) => finish(code));
  }

  /** Send follow-up text (e.g. review comments) to a running agent's stdin. */
  steer(branch: string, text: string): boolean {
    const p = this.procs.get(branch);
    if (!p?.stdin?.writable) return false;
    p.stdin.write(text + '\n');
    return true;
  }

  kill(branch: string) { this.procs.get(branch)?.kill('SIGTERM'); }
}
