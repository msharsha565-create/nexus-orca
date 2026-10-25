import type { Orchestrator, RunResult } from './pty-orchestrator.js';

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) + '\n[... diff truncated ...]' : s);

export function judgePrompt(task: string, candidates: { agent: string; diff: string }[], maxChars = 20_000): string {
  const parts = candidates.map((c, i) => `### Candidate ${i + 1} (${c.agent})\n\`\`\`diff\n${clip(c.diff, maxChars)}\n\`\`\``);
  return [
    `You are the judge. ${candidates.length} agents attempted this task independently:`,
    `"${task}"`,
    ...parts,
    'Apply ONE final change to this working tree that combines the best parts of the candidates.',
    'Prefer correct, minimal code. Do not copy mistakes. Do not mention the candidates in code.',
  ].join('\n\n');
}

/** Run a judge agent in its own worktree that merges the best parts of every candidate diff. */
export async function synthesize(orch: Orchestrator, task: string, results: RunResult[], judgeAgent: string): Promise<RunResult> {
  const candidates = [];
  for (const r of results) candidates.push({ agent: r.worktree.agent, diff: await orch.manager.diff(r.worktree) });
  const [judge] = await orch.runAll([judgeAgent], judgePrompt(task, candidates), { label: `judge-${task}` });
  return judge;
}
