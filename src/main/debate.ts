import spawn from 'cross-spawn';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Registry } from './pty-orchestrator.js';

export interface Turn { agent: string; text: string }
export interface Side { agent: string; diff: string }

/** Run an agent once for plain text. It runs in an empty temp dir so it cannot touch the repo. */
export function runAgentText(registry: Registry, agent: string, prompt: string, timeoutMs = 300_000): Promise<string> {
  const spec = registry[agent];
  if (!spec) return Promise.reject(new Error(`Unknown agent: ${agent}`));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-debate-'));
  return new Promise((resolve) => {
    const child = spawn(spec.cmd, spec.args(prompt), { cwd });
    let out = '';
    child.stdout!.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr!.on('data', (b: Buffer) => { out += b.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const done = () => { clearTimeout(timer); fs.rmSync(cwd, { recursive: true, force: true }); resolve(out.trim()); };
    child.on('error', (e) => { out += e.message; done(); });
    child.on('close', done);
  });
}

const clip = (s: string, max = 20_000) => (s.length > max ? s.slice(0, max) + '\n[... truncated ...]' : s);

/** Each agent critiques the other's diff, then answers the last critique. One round = two turns. */
export async function debate(registry: Registry, task: string, a: Side, b: Side, rounds = 1): Promise<Turn[]> {
  const turns: Turn[] = [];
  let last = '';
  for (let r = 0; r < rounds; r++) {
    for (const [me, other] of [[a, b], [b, a]] as const) {
      const prompt = [
        `Task: "${task}"`,
        `You wrote this solution:\n\`\`\`diff\n${clip(me.diff)}\n\`\`\``,
        `${other.agent} wrote this one:\n\`\`\`diff\n${clip(other.diff)}\n\`\`\``,
        last ? `${other.agent} said: ${last}` : '',
        'In under 150 words: name the strongest flaw in the other solution and the strongest flaw in yours, then say which should win and why.',
      ].filter(Boolean).join('\n\n');
      last = await runAgentText(registry, me.agent, prompt);
      turns.push({ agent: me.agent, text: last });
    }
  }
  return turns;
}

export const formatDebate = (turns: Turn[]) => turns.map((t) => `== ${t.agent} ==\n${t.text}`).join('\n\n');
