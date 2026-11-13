# NexusOrca

Run multiple AI coding agents side-by-side, each in its own isolated git worktree, then compare diffs and merge the winner. Inspired by [stablyai/orca](https://github.com/stablyai/orca).

| Piece | File |
|---|---|
| Worktree engine (`git worktree add -b orca/<agent>-<task>`, numstat/diff, merge) | `src/main/worktree-manager.ts` |
| Parallel agent spawner (claude, codex, opencode, aider, goose) | `src/main/pty-orchestrator.ts` |
| WebSocket relay (`ws://127.0.0.1:7420`) | `src/main/relay-server.ts` |
| CLI | `src/cli/orca-cli.ts` |
| Dashboard (live output, line-level review comments, merge) | `src/renderer/index.html` |

The simulated demo lives in `docs/index.html`; an X-ray anatomy view of how it works is in `docs/xray.html`; a replay viewer is in `docs/replay.html` (all served by GitHub Pages).

## Usage
```sh
pnpm install
pnpm test
pnpm dev /path/to/repo            # start relay, then open src/renderer/index.html
pnpm cli fanout --repo . --agents claude-code,codex --prompt "add input validation"
```
Agent CLIs must be installed and on `PATH`; flags per agent are in `AGENTS` (edit to taste). Agents run as plain child processes (no PTY), so interactive TUIs are not supported; use their non-interactive modes.

## Commands

| Command | What it does |
|---|---|
| `orca fanout --prompt "..." [--test cmd] [--record]` | Run every agent in its own worktree, then score each (exit status, tests, diff size, speed) with an estimated cost. |
| `orca tournament --tasks tasks.json [--test cmd] [--out board.json]` | Run many tasks across all agents and print a leaderboard. `tasks.json` is `[{"name":"x","prompt":"...","test":"pnpm test"}]`. |
| `orca synth --prompt "..." --agents a,b --judge c` | A judge agent combines the best parts of every candidate diff into a new branch. |
| `orca debate --prompt "..." --agents a,b [--rounds 2]` | Two agents critique each other's diffs; you read the argument. |
| `orca replay file.jsonl [--speed 4]` | Replay a recorded run in the terminal, or scrub it in `docs/replay.html`. |
| `orca issue --number 12 [--test cmd] [--pr]` | Fan out on a GitHub issue and open the best branch as a draft PR. Needs `GITHUB_TOKEN`. |
| `orca autopilot [--label orca] [--limit 3] [--pr]` | Do the same for open issues with a label. Remembers handled issues in `.orca/autopilot.json`; run it from cron to work a backlog. |
| `orca list` | List Orca worktrees. |

**Scoring** (max 100 per task): exit 0 = 20, tests pass = 60, up to 10 for the smallest diff, up to 10 for the fastest run. Size and speed only count for runs that exited 0 and changed something.

**Cost** is an estimate from prompt and printed output (about 4 characters per token). It cannot see files an agent read or hidden reasoning, so it is a lower bound. Rates are placeholders in `src/main/cost.ts`; override with `ORCA_RATES='{"codex":{"inPerM":1,"outPerM":8}}'`.

**Commits** use the repo's own `git config user.name/email`, so they are yours. Orca falls back to `orca <orca@localhost>` only when none is set.

## Phone control
`pnpm dev` also prints a phone URL (`http://<machine>:7420/?token=...`) that lists worktrees, starts fan-outs and merges winners. By default the relay listens on localhost only. To reach it from a phone, set `ORCA_HOST=0.0.0.0` and put it behind a TLS tunnel (Tailscale, Cloudflare Tunnel). Do not expose plain HTTP to an untrusted network.

## Security
The relay binds to localhost and requires a shared token. `pnpm dev` prints a dashboard URL containing a random token; set `ORCA_TOKEN` to choose your own. Connections without the token are rejected. Anyone holding the token can run agents and merge branches, so keep it secret and do not expose the port to a network.
