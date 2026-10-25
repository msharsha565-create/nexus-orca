import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateCost, formatUsd, loadRates } from '../src/main/cost.ts';
import { debate } from '../src/main/debate.ts';
import { openDraftPr, parseRemote } from '../src/main/github.ts';
import { issueToPr } from '../src/main/issue-to-pr.ts';
import { Orchestrator, type Registry } from '../src/main/pty-orchestrator.ts';
import { loadFrames, record, replay } from '../src/main/recorder.ts';
import { judgePrompt, synthesize } from '../src/main/synthesize.ts';
import { leaderboard, pickWinner, runTournament, scoreRuns, type RunBase } from '../src/main/tournament.ts';

function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-f-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: d });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'a.txt'), 'hello\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  g('config', 'user.name', 't');
  g('config', 'user.email', 't@t');
  return d;
}
// Fake agent: writes `file` with `body` (nothing when file is empty), then prints a line.
const writer = (file: string, body: string) => ({
  cmd: 'sh',
  args: (p: string) => ['-c', file ? `printf '%s\\n' "${body}" > ${file}; echo "wrote ${file}"` : 'echo "did nothing"', p],
});

test('scoring rewards passing tests and ignores do-nothing runs', () => {
  const base = (o: Partial<RunBase>): RunBase => ({ task: 't', agent: 'x', branch: 'b', ok: true, testsPassed: true, changed: 10, durationMs: 1000, costUsd: 0.01, ...o });
  const runs = scoreRuns([
    base({ agent: 'good' }),
    base({ agent: 'failing', testsPassed: false }),
    base({ agent: 'noop', changed: 0, testsPassed: false, durationMs: 1 }),
    base({ agent: 'crashed', ok: false, testsPassed: false }),
  ]);
  const s = Object.fromEntries(runs.map((r) => [r.agent, r.score]));
  assert.equal(s.good, 100);
  assert.equal(s.failing, 40);
  assert.equal(s.noop, 20);
  assert.equal(s.crashed, 0);
  assert.equal(pickWinner(runs)?.agent, 'good');
  const board = leaderboard(runs);
  assert.equal(board[0].agent, 'good');
  assert.equal(board[0].wins, 1);
  assert.equal(board.find((r) => r.agent === 'failing')!.passRate, 0);
});

test('tournament runs every task for every agent and cleans up', async () => {
  const repo = tmpRepo();
  const orch = new Orchestrator(repo, { good: writer('ok.txt', 'yes'), lazy: writer('', '') });
  const { runs, board } = await runTournament(orch, ['good', 'lazy'], [{ prompt: 'one' }, { prompt: 'two' }], { test: 'test -f ok.txt' });
  assert.equal(runs.length, 4);
  assert.equal(board[0].agent, 'good');
  assert.equal(board[0].wins, 2);
  assert.equal((await orch.manager.list()).length, 0);
});

test('worktree branches never collide on rerun', async () => {
  const repo = tmpRepo();
  const orch = new Orchestrator(repo, {});
  const a = await orch.manager.create('x', 'same');
  const b = await orch.manager.create('x', 'same');
  assert.notEqual(a.branch, b.branch);
});

test('cost estimate is derived from prompt and output size', () => {
  const c = estimateCost('codex', 'a'.repeat(4000), 'b'.repeat(8000), { codex: { inPerM: 1, outPerM: 10 } });
  assert.deepEqual([c.inTokens, c.outTokens], [1000, 2000]);
  assert.ok(Math.abs(c.usd - 0.021) < 1e-9);
  assert.equal(formatUsd(0.001), '<$0.01');
  assert.equal(loadRates('{"x":{"inPerM":1,"outPerM":2}}').x.outPerM, 2);
  assert.equal(loadRates('not json')['claude-code'].inPerM > 0, true);
});

test('recording captures a run and replays it in order', async () => {
  const repo = tmpRepo();
  const orch = new Orchestrator(repo, { a: writer('o.txt', 'hi') });
  const rec = record(orch, path.join(repo, '.orca', 'rec'));
  await orch.runAll(['a'], 'go');
  rec.stop();
  const frames = loadFrames(rec.file);
  assert.deepEqual(frames.map((f) => f.type)[0], 'start');
  assert.equal(frames.at(-1)!.type, 'exit');
  const lines: string[] = [];
  await replay(frames, (l) => lines.push(l), 4, async () => {});
  assert.ok(lines.includes('[a] wrote o.txt'));
  assert.match(lines.at(-1)!, /exit 0/);
});

test('judge sees every candidate diff and produces its own branch', async () => {
  const repo = tmpRepo();
  const orch = new Orchestrator(repo, { a: writer('a.out', 'A'), b: writer('b.out', 'B'), judge: writer('final.txt', 'combined') });
  const results = await orch.runAll(['a', 'b'], 'build it');
  const prompt = judgePrompt('build it', [{ agent: 'a', diff: 'DIFF-A' }, { agent: 'b', diff: 'DIFF-B' }]);
  assert.match(prompt, /Candidate 2 \(b\)[\s\S]*DIFF-B/);
  const final = await synthesize(orch, 'build it', results, 'judge');
  assert.ok(fs.existsSync(path.join(final.worktree.dir, 'final.txt')));
  assert.match(final.worktree.branch, /judge-build-it/);
  assert.match(final.prompt, /\+A|a\.out/);
});

test('debate alternates agents and passes the opponent diff', async () => {
  const echo: Registry = {
    a: { cmd: 'sh', args: (p) => ['-c', 'echo "A saw:"; echo "$0" | grep -c "DIFF-B"', p] },
    b: { cmd: 'sh', args: (p) => ['-c', 'echo "B saw:"; echo "$0" | grep -c "DIFF-A"', p] },
  };
  const turns = await debate(echo, 'task', { agent: 'a', diff: 'DIFF-A' }, { agent: 'b', diff: 'DIFF-B' }, 2);
  assert.deepEqual(turns.map((t) => t.agent), ['a', 'b', 'a', 'b']);
  assert.match(turns[0].text, /A saw:\n1/);
  assert.match(turns[1].text, /B saw:\n1/);
});

test('github helpers parse remotes and open draft PRs', async () => {
  assert.deepEqual(parseRemote('git@github.com:me/repo.git'), { owner: 'me', repo: 'repo' });
  assert.deepEqual(parseRemote('https://github.com/me/repo'), { owner: 'me', repo: 'repo' });
  assert.equal(parseRemote('https://example.com/x/y'), null);
  let seen: any;
  const f = (async (url: string, init: any) => { seen = { url, body: JSON.parse(init.body), auth: init.headers.Authorization }; return { ok: true, json: async () => ({ html_url: 'https://gh/pr/9' }) }; }) as any;
  const url = await openDraftPr({ owner: 'me', repo: 'repo' }, 'tok', { head: 'h', base: 'main', title: 't', body: 'b' }, f);
  assert.equal(url, 'https://gh/pr/9');
  assert.equal(seen.body.draft, true);
  assert.equal(seen.auth, 'Bearer tok');
  assert.match(seen.url, /repos\/me\/repo\/pulls$/);
});

test('issue to PR picks the passing agent, pushes its branch, opens a draft PR', async () => {
  const repo = tmpRepo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-remote-'));
  execFileSync('git', ['init', '-q', '--bare'], { cwd: remote });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
  const orch = new Orchestrator(repo, { good: writer('ok.txt', 'fixed'), lazy: writer('', '') });
  let body: any;
  const f = (async (_u: string, init: any) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ html_url: 'https://gh/pr/1' }) }; }) as any;
  const out = await issueToPr(orch, { number: 7, title: 'Broken thing', body: 'please fix' }, {
    agents: ['good', 'lazy'], test: 'test -f ok.txt', base: 'main', push: true, slug: { owner: 'me', repo: 'r' }, token: 't', fetchFn: f,
  });
  assert.equal(out.status, 'pr');
  assert.match(body.head, /^orca\/good-/);
  assert.match(body.body, /Closes #7/);
  assert.match(execFileSync('git', ['branch', '--list'], { cwd: remote }).toString(), /orca\/good-/);
  assert.equal((await orch.manager.list()).length, 0);
  const committer = execFileSync('git', ['log', '-1', '--format=%an', body.head], { cwd: repo }).toString().trim();
  assert.equal(committer, 't'); // uses the repo's git identity
});

test('issue to PR reports no winner when nothing passes', async () => {
  const repo = tmpRepo();
  const orch = new Orchestrator(repo, { lazy: writer('', '') });
  const out = await issueToPr(orch, { number: 1, title: 'x', body: '' }, { agents: ['lazy'], test: 'false', base: 'main', push: false });
  assert.equal(out.status, 'no-winner');
});
