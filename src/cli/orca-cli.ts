#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { Orchestrator, type AgentEvent } from '../main/pty-orchestrator.js';

const [cmd, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    repo: { type: 'string', default: '.' },
    agents: { type: 'string', default: 'claude-code' },
    prompt: { type: 'string' },
  },
});
const orch = new Orchestrator(path.resolve(values.repo!));

if (cmd === 'list') {
  for (const w of await orch.manager.list()) console.log(`${w.branch}\t${w.dir}`);
} else if (cmd === 'fanout') {
  if (!values.prompt) { console.error('--prompt is required'); process.exit(2); }
  let running = 0;
  orch.on('event', async (e: AgentEvent) => {
    const tag = `[${e.worktree.agent}]`;
    if (e.type === 'start') running++;
    else if (e.type === 'data') e.chunk.split('\n').filter(Boolean).forEach((l) => console.log(`${tag} ${l}`));
    else {
      const stats = await orch.manager.stats(e.worktree);
      const total = stats.reduce((a, s) => ({ a: a.a + s.added, r: a.r + s.removed }), { a: 0, r: 0 });
      console.log(`${tag} exit ${e.code} in ${e.durationMs}ms  +${total.a} -${total.r} (${stats.length} files)`);
      if (--running === 0) console.log('All agents finished. Merge a winner with the relay or `git merge <branch>`.');
    }
  });
  try { await orch.fanout(values.agents!.split(','), values.prompt); }
  catch (e) { console.error((e as Error).message); process.exit(1); }
} else {
  console.log('usage: orca <fanout|list> [--repo .] [--agents claude-code,codex] [--prompt "..."]');
}
