import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, Orchestrator } from './pty-orchestrator.js';

export interface Frame {
  at: number; type: 'start' | 'data' | 'exit'; branch: string; agent: string;
  stream?: 'stdout' | 'stderr'; chunk?: string; code?: number | null; durationMs?: number;
}

/** Append every agent event to a JSONL file so a run can be replayed later. */
export function record(orch: Orchestrator, dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}.jsonl`);
  const handler = (e: AgentEvent) => {
    const frame: Frame = { at: Date.now(), type: e.type, branch: e.worktree.branch, agent: e.worktree.agent };
    if (e.type === 'data') { frame.stream = e.stream; frame.chunk = e.chunk; }
    if (e.type === 'exit') { frame.code = e.code; frame.durationMs = e.durationMs; }
    fs.appendFileSync(file, JSON.stringify(frame) + '\n');
  };
  orch.on('event', handler);
  return { file, stop: () => orch.off('event', handler) };
}

export function loadFrames(file: string): Frame[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Frame);
}

/** Print a recording with its original timing, scaled by `speed` (waits are capped at 2s). */
export async function replay(
  frames: Frame[], write: (line: string) => void, speed = 1,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
) {
  let prev = frames[0]?.at ?? 0;
  for (const f of frames) {
    const wait = Math.min((f.at - prev) / speed, 2000);
    if (wait > 0 && Number.isFinite(wait)) await sleep(wait);
    prev = f.at;
    const tag = `[${f.agent}]`;
    if (f.type === 'start') write(`${tag} started`);
    else if (f.type === 'exit') write(`${tag} exit ${f.code} after ${f.durationMs}ms`);
    else for (const l of (f.chunk ?? '').split('\n').filter(Boolean)) write(`${tag} ${l}`);
  }
}
