import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';

const run = promisify(execFile);

export interface Worktree {
  agent: string;
  task: string;
  branch: string;
  dir: string;
  repo: string;
}

export interface DiffStat { file: string; added: number; removed: number }

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export class WorktreeManager {
  constructor(private repo: string, private root = path.join(repo, '.orca-worktrees')) {}

  /** Create an isolated worktree on branch orca/<agent>-<task>. */
  async create(agent: string, task: string): Promise<Worktree> {
    const name = `${slug(agent)}-${slug(task)}`;
    const branch = `orca/${name}`;
    const dir = path.join(this.root, name);
    await fs.mkdir(this.root, { recursive: true });
    await git(this.repo, 'worktree', 'add', '-b', branch, dir);
    return { agent, task, branch, dir, repo: this.repo };
  }

  async list(): Promise<Worktree[]> {
    const out = await git(this.repo, 'worktree', 'list', '--porcelain');
    const result: Worktree[] = [];
    for (const block of out.split('\n\n')) {
      const dir = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(orca\/.+)$/m.exec(block)?.[1];
      if (!dir || !branch) continue;
      const rest = branch.slice('orca/'.length);
      const i = rest.indexOf('-');
      result.push({
        agent: i < 0 ? rest : rest.slice(0, i), task: i < 0 ? '' : rest.slice(i + 1),
        branch, dir, repo: this.repo,
      });
    }
    return result;
  }

  /** Stage everything so untracked files appear in diffs. */
  private async stage(wt: Worktree) { await git(wt.dir, 'add', '-A'); }

  async stats(wt: Worktree): Promise<DiffStat[]> {
    await this.stage(wt);
    const out = await git(wt.dir, 'diff', '--cached', '--numstat', 'HEAD');
    return out.split('\n').filter(Boolean).map((l) => {
      const [a, r, ...f] = l.split('\t');
      return { file: f.join('\t'), added: a === '-' ? 0 : +a, removed: r === '-' ? 0 : +r };
    });
  }

  async diff(wt: Worktree): Promise<string> {
    await this.stage(wt);
    return git(wt.dir, 'diff', '--cached', 'HEAD');
  }

  /** Commit the agent's work and merge its branch into the base branch of the main checkout. */
  async merge(wt: Worktree, message = `orca: merge ${wt.branch}`): Promise<void> {
    await this.stage(wt);
    const dirty = (await git(wt.dir, 'status', '--porcelain')).trim();
    if (dirty) {
      await git(wt.dir, '-c', 'user.name=orca', '-c', 'user.email=orca@localhost', 'commit', '-m', message);
    }
    await git(this.repo, '-c', 'user.name=orca', '-c', 'user.email=orca@localhost',
      'merge', '--no-ff', '-m', message, wt.branch);
  }

  async remove(wt: Worktree): Promise<void> {
    await git(this.repo, 'worktree', 'remove', '--force', wt.dir);
    await git(this.repo, 'branch', '-D', wt.branch);
  }
}
