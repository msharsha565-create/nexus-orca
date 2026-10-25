#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { formatUsd } from '../main/cost.js';
import { debate, formatDebate } from '../main/debate.js';
import { getIssue, listIssues, parseRemote } from '../main/github.js';
import { issueToPr, loadDone, saveDone } from '../main/issue-to-pr.js';
import { Orchestrator, type AgentEvent } from '../main/pty-orchestrator.js';
import { loadFrames, record, replay } from '../main/recorder.js';
import { synthesize } from '../main/synthesize.js';
import { evaluate, formatLeaderboard, runTournament, type Task } from '../main/tournament.js';

const [cmd, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    repo: { type: 'string', default: '.' },
    agents: { type: 'string', default: 'claude-code' },
    prompt: { type: 'string' },
    tasks: { type: 'string' },
    test: { type: 'string' },
    out: { type: 'string' },
    judge: { type: 'string' },
    rounds: { type: 'string', default: '1' },
    speed: { type: 'string', default: '1' },
    number: { type: 'string' },
    label: { type: 'string', default: 'orca' },
    limit: { type: 'string', default: '3' },
    base: { type: 'string', default: 'main' },
    keep: { type: 'boolean', default: false },
    record: { type: 'boolean', default: false },
    pr: { type: 'boolean', default: false },
  },
});

const repo = path.resolve(values.repo!);
const orch = new Orchestrator(repo);
const agents = values.agents!.split(',').map((s) => s.trim()).filter(Boolean);
const need = (v: string | undefined, flag: string) => { if (!v) { console.error(`${flag} is required`); process.exit(2); } return v; };

function stream() {
  orch.on('event', (e: AgentEvent) => {
    if (e.type === 'data') e.chunk.split('\n').filter(Boolean).forEach((l) => console.log(`[${e.worktree.agent}] ${l}`));
  });
}

function remote() {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo }).toString();
  const slug = parseRemote(url);
  const token = process.env.GITHUB_TOKEN;
  if (!slug || !token) { console.error('Needs a github.com origin remote and GITHUB_TOKEN'); process.exit(2); }
  return { slug, token };
}

async function main() {
  switch (cmd) {
    case 'list':
      for (const w of await orch.manager.list()) console.log(`${w.branch}\t${w.dir}`);
      return;

    case 'fanout': {
      const prompt = need(values.prompt, '--prompt');
      stream();
      const rec = values.record ? record(orch, path.join(repo, '.orca', 'recordings')) : null;
      const results = await orch.runAll(agents, prompt);
      const runs = await evaluate(orch.manager, results, 'fanout', values.test);
      for (const r of runs) {
        console.log(`[${r.agent}] exit ${r.ok ? 0 : 'non-zero'} in ${r.durationMs}ms  ${r.changed} lines changed  est. ${formatUsd(r.costUsd)}${r.testsPassed === null ? '' : r.testsPassed ? '  tests pass' : '  tests FAIL'}  score ${r.score}`);
      }
      if (rec) { rec.stop(); console.log(`Recording: ${rec.file}`); }
      console.log('Merge a winner from the dashboard, phone page, or `git merge <branch>`.');
      return;
    }

    case 'tournament': {
      const tasks = JSON.parse(fs.readFileSync(need(values.tasks, '--tasks'), 'utf8')) as Task[];
      const { runs, board } = await runTournament(orch, agents, tasks, {
        test: values.test, keep: values.keep,
        onRun: (r) => console.log(`${r.task} / ${r.agent}: score ${r.score}`),
      });
      console.log('\n' + formatLeaderboard(board));
      if (values.out) fs.writeFileSync(values.out, JSON.stringify({ runs, board }, null, 2));
      return;
    }

    case 'synth': {
      const prompt = need(values.prompt, '--prompt');
      const judge = need(values.judge, '--judge');
      const results = await orch.runAll(agents, prompt);
      const merged = await synthesize(orch, prompt, results, judge);
      console.log(`Judge branch: ${merged.worktree.branch} (${merged.worktree.dir})`);
      return;
    }

    case 'debate': {
      const prompt = need(values.prompt, '--prompt');
      if (agents.length !== 2) { console.error('--agents needs exactly two agents'); process.exit(2); }
      const results = await orch.runAll(agents, prompt);
      const [a, b] = await Promise.all(results.map(async (r) => ({ agent: r.worktree.agent, diff: await orch.manager.diff(r.worktree) })));
      console.log(formatDebate(await debate(orch.registry, prompt, a, b, Number(values.rounds))));
      return;
    }

    case 'replay': {
      const file = need(positionals[0], 'recording file');
      await replay(loadFrames(file), console.log, Number(values.speed));
      return;
    }

    case 'issue':
    case 'autopilot': {
      const { slug, token } = remote();
      const opts = { agents, test: values.test, base: values.base, push: values.pr, slug, token };
      const report = (n: number, o: Awaited<ReturnType<typeof issueToPr>>) =>
        console.log(`#${n}: ${o.status}${'url' in o ? ' ' + o.url : ''}${'branch' in o ? ' ' + o.branch : ''}`);
      if (cmd === 'issue') {
        const n = Number(need(values.number, '--number'));
        report(n, await issueToPr(orch, await getIssue(slug, n, token), opts));
        return;
      }
      const stateFile = path.join(repo, '.orca', 'autopilot.json');
      const done = loadDone(stateFile);
      const todo = (await listIssues(slug, values.label!, token)).filter((i) => !done.includes(i.number)).slice(0, Number(values.limit));
      for (const issue of todo) {
        report(issue.number, await issueToPr(orch, issue, opts));
        done.push(issue.number);
        saveDone(stateFile, done);
      }
      if (!todo.length) console.log(`No new open issues labelled "${values.label}".`);
      return;
    }

    default:
      console.log(`usage: orca <command> [--repo .] [--agents a,b]
  fanout      --prompt "..." [--test cmd] [--record]
  tournament  --tasks tasks.json [--test cmd] [--out board.json] [--keep]
  synth       --prompt "..." --agents a,b --judge c
  debate      --prompt "..." --agents a,b [--rounds 1]
  replay      <recording.jsonl> [--speed 4]
  issue       --number N [--test cmd] [--pr] [--base main]
  autopilot   [--label orca] [--limit 3] [--test cmd] [--pr]
  list`);
  }
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
