import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorktreeManager } from '../src/main/worktree-manager.ts';
import { Orchestrator, type AgentEvent } from '../src/main/pty-orchestrator.ts';

function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: d });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'a.txt'), 'hello\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return d;
}

test('worktree lifecycle: create, diff, merge, remove', async () => {
  const repo = tmpRepo();
  const m = new WorktreeManager(repo);
  const wt = await m.create('claude-code', 'Fix bug!');
  assert.equal(wt.branch, 'orca/claude-code-fix-bug');
  fs.writeFileSync(path.join(wt.dir, 'b.txt'), 'x\ny\n');
  assert.deepEqual(await m.stats(wt), [{ file: 'b.txt', added: 2, removed: 0 }]);
  assert.match(await m.diff(wt), /\+x/);
  assert.equal((await m.list()).length, 1);
  await m.merge(wt);
  assert.ok(fs.existsSync(path.join(repo, 'b.txt')));
  await m.remove(wt);
  assert.equal((await m.list()).length, 0);
});

test('fanout runs agents in separate worktrees', async () => {
  const repo = tmpRepo();
  const sh = (name: string) => ({ cmd: 'sh', args: (p: string) => ['-c', `echo ${name} > out.txt; echo "$0"`, p] });
  const orch = new Orchestrator(repo, { one: sh('one'), two: sh('two') });
  const exits: AgentEvent[] = [];
  const done = new Promise<void>((res) => orch.on('event', (e: AgentEvent) => {
    if (e.type === 'exit') { exits.push(e); if (exits.length === 2) res(); }
  }));
  const wts = await orch.fanout(['one', 'two'], 'task');
  await done;
  assert.notEqual(wts[0].dir, wts[1].dir);
  assert.equal(fs.readFileSync(path.join(wts[0].dir, 'out.txt'), 'utf8'), 'one\n');
  assert.equal(fs.readFileSync(path.join(wts[1].dir, 'out.txt'), 'utf8'), 'two\n');
  assert.ok(!fs.existsSync(path.join(repo, 'out.txt')));
});
