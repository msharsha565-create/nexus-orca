import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { WorktreeManager, type Worktree } from './worktree-manager.js';

/** How each supported agent CLI accepts a one-shot prompt. */
export type Registry = Record<string, { cmd: string; args: (prompt: string) => string[] }>;

export const AGENTS: Registry = {
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

export interface RunResult {
  worktree: Worktree;
  prompt: string;
  code: number | null;
  durationMs: number;
  output: string;
}

export class Orchestrator extends EventEmitter {
  private procs = new Map<string, ChildProcess>();
  readonly manager: WorktreeManager;

  constructor(repo: string, readonly registry: Registry = AGENTS) {
    super();
    this.manager = new WorktreeManager(repo);
  }

  /** Fan one prompt out to every agent, each in its own worktree. */
  async fanout(agents: string[], prompt: string, opts: { label?: string } = {}): Promise<Worktree[]> {
    const unknown = agents.filter((a) => !this.registry[a]);
    if (unknown.length) throw new Error(`Unknown agent(s): ${unknown.join(', ')}`);
    const worktrees = await Promise.all(agents.map((a) => this.manager.create(a, opts.label ?? prompt)));
    worktrees.forEach((wt) => this.launch(wt, prompt));
    return worktrees;
  }

  /** Fan out and wait until every agent has exited, collecting each one's output. */
  async runAll(agents: string[], prompt: string, opts: { label?: string } = {}): Promise<RunResult[]> {
    const output = new Map<string, string>();
    const finished = new Map<string, RunResult>();
    let expected = -1;
    let release!: () => void;
    const all = new Promise<void>((r) => { release = r; });
    const check = () => { if (expected >= 0 && finished.size >= expected) release(); };
    const onEvent = (e: AgentEvent) => {
      const key = e.worktree.branch;
      if (e.type === 'data') output.set(key, (output.get(key) ?? '') + e.chunk);
      if (e.type === 'exit') {
        finished.set(key, { worktree: e.worktree, prompt, code: e.code, durationMs: e.durationMs, output: output.get(key) ?? '' });
        check();
      }
    };
    this.on('event', onEvent);
    try {
      const wts = await this.fanout(agents, prompt, opts);
      expected = wts.length;
      check();
      await all;
      return wts.map((w) => finished.get(w.branch)!);
    } finally {
      this.off('event', onEvent);
    }
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
