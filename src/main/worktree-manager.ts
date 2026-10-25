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
    const base = `${slug(agent)}-${slug(task)}`;
    let name = base;
    for (let n = 2; await this.branchExists(`orca/${name}`); n++) name = `${base}-${n}`;
    const branch = `orca/${name}`;
    const dir = path.join(this.root, name);
    await fs.mkdir(this.root, { recursive: true });
    await git(this.repo, 'worktree', 'add', '-b', branch, dir);
    return { agent, task, branch, dir, repo: this.repo };
  }

  private async branchExists(branch: string): Promise<boolean> {
    try { await git(this.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`); return true; }
    catch { return false; }
  }

  /** Use the repo's own git identity when set, so commits are the user's; fall back to "orca". */
  private async identity(cwd: string): Promise<string[]> {
    try { if ((await git(cwd, 'config', 'user.name')).trim()) return []; } catch { /* unset */ }
    return ['-c', 'user.name=orca', '-c', 'user.email=orca@localhost'];
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

  /** Commit everything in the worktree. Returns false when there was nothing to commit. */
  async commit(wt: Worktree, message = `orca: ${wt.branch}`): Promise<boolean> {
    await this.stage(wt);
    if (!(await git(wt.dir, 'status', '--porcelain')).trim()) return false;
    await git(wt.dir, ...(await this.identity(wt.dir)), 'commit', '-m', message);
    return true;
  }

  /** Commit the agent's work and merge its branch into the base branch of the main checkout. */
  async merge(wt: Worktree, message = `orca: merge ${wt.branch}`): Promise<void> {
    await this.commit(wt, message);
    await git(this.repo, ...(await this.identity(this.repo)), 'merge', '--no-ff', '-m', message, wt.branch);
  }

  async push(wt: Worktree): Promise<void> {
    await git(this.repo, 'push', '-u', 'origin', wt.branch);
  }

  async remove(wt: Worktree, opts: { keepBranch?: boolean } = {}): Promise<void> {
    await git(this.repo, 'worktree', 'remove', '--force', wt.dir);
    if (!opts.keepBranch) await git(this.repo, 'branch', '-D', wt.branch);
  }
}
