import fs from 'node:fs';
import path from 'node:path';
import { formatUsd } from './cost.js';
import { openDraftPr, type Issue, type Slug } from './github.js';
import type { Orchestrator } from './pty-orchestrator.js';
import { evaluate, pickWinner, type Run } from './tournament.js';

export interface IssueOptions {
  agents: string[]; test?: string; base: string; push: boolean;
  slug?: Slug; token?: string; fetchFn?: typeof fetch;
}
export type IssueOutcome =
  | { status: 'no-winner'; runs: Run[] }
  | { status: 'ready'; branch: string; runs: Run[] }
  | { status: 'pr'; branch: string; url: string; runs: Run[] };

export const issuePrompt = (i: Issue) => `Resolve GitHub issue #${i.number}: ${i.title}\n\n${i.body}`.trim();

export function prBody(i: Issue, runs: Run[], winner: Run): string {
  const rows = runs.map((r) =>
    `| ${r.agent === winner.agent ? '**' + r.agent + '**' : r.agent} | ${r.score} | ${r.testsPassed === null ? '-' : r.testsPassed ? 'pass' : 'fail'} | ${r.changed} | ${(r.durationMs / 1000).toFixed(1)}s | ${formatUsd(r.costUsd)} |`);
  return [
    `Closes #${i.number}`,
    `Several agents attempted this in separate worktrees. The highest-scoring run is this branch.`,
    '| agent | score | tests | lines changed | time | est. cost |', '|---|---|---|---|---|---|', ...rows,
    '_Draft: review before merging._',
  ].join('\n');
}

/** Fan out on an issue, score the runs, and push the best branch as a draft PR. */
export async function issueToPr(orch: Orchestrator, issue: Issue, o: IssueOptions): Promise<IssueOutcome> {
  const results = await orch.runAll(o.agents, issuePrompt(issue), { label: `issue-${issue.number}` });
  const runs = await evaluate(orch.manager, results, `issue-${issue.number}`, o.test);
  const winner = pickWinner(runs);
  const keep = results.find((r) => r.worktree.branch === winner?.branch);
  for (const r of results) if (r !== keep) await orch.manager.remove(r.worktree);
  if (!winner || !keep) return { status: 'no-winner', runs };

  await orch.manager.commit(keep.worktree, `Fix #${issue.number}: ${issue.title}`);
  if (!o.push) return { status: 'ready', branch: winner.branch, runs };
  if (!o.slug || !o.token) throw new Error('Pushing needs a GitHub remote and GITHUB_TOKEN');
  await orch.manager.push(keep.worktree);
  await orch.manager.remove(keep.worktree, { keepBranch: true });
  const url = await openDraftPr(o.slug, o.token, {
    head: winner.branch, base: o.base, title: `Fix #${issue.number}: ${issue.title}`, body: prBody(issue, runs, winner),
  }, o.fetchFn);
  return { status: 'pr', branch: winner.branch, url, runs };
}

/** Issue numbers already handled by autopilot, so reruns skip them. */
export function loadDone(file: string): number[] {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as number[]; } catch { return []; }
}
export function saveDone(file: string, done: number[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(done));
}
