import { estimateCost, loadRates, type Rates } from './cost.js';
import type { Orchestrator, RunResult } from './pty-orchestrator.js';
import { runShell } from './shell.js';
import type { WorktreeManager } from './worktree-manager.js';

export interface Task { name?: string; prompt: string; test?: string }

export interface RunBase {
  task: string;
  agent: string;
  branch: string;
  ok: boolean;                 // agent exited 0
  testsPassed: boolean | null; // null = no test command
  changed: number;             // added + removed lines
  durationMs: number;
  costUsd: number;
}
export interface Run extends RunBase { score: number }

export interface Row {
  agent: string; runs: number; wins: number; avgScore: number;
  passRate: number | null; avgMs: number; costUsd: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Score per task, max 100: exit 0 = 20, tests pass = 60, then up to 10 for the smallest diff
 * and up to 10 for the fastest run. Size and speed only count for runs that exited 0 and changed something.
 */
export function scoreRuns(runs: RunBase[]): Run[] {
  const byTask = new Map<string, RunBase[]>();
  for (const r of runs) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r]);
  const out: Run[] = [];
  for (const group of byTask.values()) {
    const eligible = group.filter((r) => r.ok && r.changed > 0);
    const minChanged = Math.min(...eligible.map((r) => r.changed));
    const minMs = Math.min(...eligible.map((r) => Math.max(r.durationMs, 1)));
    for (const r of group) {
      let score = (r.ok ? 20 : 0) + (r.testsPassed === true ? 60 : 0);
      if (r.ok && r.changed > 0) score += (10 * minChanged) / r.changed + (10 * minMs) / Math.max(r.durationMs, 1);
      out.push({ ...r, score: round1(score) });
    }
  }
  return out;
}

export function leaderboard(runs: Run[]): Row[] {
  const best = new Map<string, number>();
  for (const r of runs) best.set(r.task, Math.max(best.get(r.task) ?? 0, r.score));
  const agents = [...new Set(runs.map((r) => r.agent))];
  const rows = agents.map((agent): Row => {
    const mine = runs.filter((r) => r.agent === agent);
    const tested = mine.filter((r) => r.testsPassed !== null);
    return {
      agent,
      runs: mine.length,
      wins: mine.filter((r) => r.score > 0 && r.score === best.get(r.task)).length,
      avgScore: round1(mine.reduce((a, r) => a + r.score, 0) / mine.length),
      passRate: tested.length ? tested.filter((r) => r.testsPassed).length / tested.length : null,
      avgMs: Math.round(mine.reduce((a, r) => a + r.durationMs, 0) / mine.length),
      costUsd: mine.reduce((a, r) => a + r.costUsd, 0),
    };
  });
  return rows.sort((a, b) => b.avgScore - a.avgScore || b.wins - a.wins);
}

export function formatLeaderboard(rows: Row[]): string {
  const head = ['agent', 'avg score', 'wins', 'tests', 'avg time', 'est. cost'];
  const body = rows.map((r) => [
    r.agent, r.avgScore.toFixed(1), String(r.wins),
    r.passRate === null ? '-' : `${Math.round(r.passRate * 100)}%`,
    `${(r.avgMs / 1000).toFixed(1)}s`, `$${r.costUsd.toFixed(3)}`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [fmt(head), fmt(widths.map((w) => '-'.repeat(w))), ...body.map(fmt)].join('\n');
}

/** Turn finished agent runs into scored runs: count changed lines, run tests, estimate cost. */
export async function evaluate(
  manager: WorktreeManager, results: RunResult[], taskName: string, test?: string, rates: Rates = loadRates(),
): Promise<Run[]> {
  const base: RunBase[] = [];
  for (const r of results) {
    const stats = await manager.stats(r.worktree);
    const testsPassed = test ? (await runShell(test, r.worktree.dir)).code === 0 : null;
    base.push({
      task: taskName, agent: r.worktree.agent, branch: r.worktree.branch,
      ok: r.code === 0, testsPassed,
      changed: stats.reduce((a, s) => a + s.added + s.removed, 0),
      durationMs: r.durationMs,
      costUsd: estimateCost(r.worktree.agent, r.prompt, r.output, rates).usd,
    });
  }
  return scoreRuns(base);
}

/** Best run that exited cleanly, changed something, and did not fail its tests. */
export function pickWinner(runs: Run[]): Run | undefined {
  return runs
    .filter((r) => r.ok && r.changed > 0 && r.testsPassed !== false)
    .sort((a, b) => b.score - a.score || a.costUsd - b.costUsd)[0];
}

export async function runTournament(
  orch: Orchestrator, agents: string[], tasks: Task[],
  opts: { test?: string; keep?: boolean; onRun?: (r: Run) => void } = {},
): Promise<{ runs: Run[]; board: Row[] }> {
  const all: Run[] = [];
  for (const [i, task] of tasks.entries()) {
    const name = task.name ?? `task-${i + 1}`;
    const results = await orch.runAll(agents, task.prompt, { label: name });
    const scored = await evaluate(orch.manager, results, name, task.test ?? opts.test);
    scored.forEach((r) => opts.onRun?.(r));
    all.push(...scored);
    if (!opts.keep) for (const r of results) await orch.manager.remove(r.worktree);
  }
  return { runs: all, board: leaderboard(all) };
}
