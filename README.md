# NexusOrca

Run multiple AI coding agents side-by-side, each in its own isolated git worktree, then compare diffs and merge the winner. Inspired by [stablyai/orca](https://github.com/stablyai/orca).

| Piece | File |
|---|---|
| Worktree engine (`git worktree add -b orca/<agent>-<task>`, numstat/diff, merge) | `src/main/worktree-manager.ts` |
| Parallel agent spawner (claude, codex, opencode, aider, goose) | `src/main/pty-orchestrator.ts` |
| WebSocket relay (`ws://127.0.0.1:7420`) | `src/main/relay-server.ts` |
| CLI | `src/cli/orca-cli.ts` |
| Dashboard (live output, line-level review comments, merge) | `src/renderer/index.html` |

The simulated demo lives in `docs/index.html` (serve it with GitHub Pages: Settings → Pages → Deploy from a branch → `/docs`).

## Usage
```sh
pnpm install
pnpm test
pnpm dev /path/to/repo            # start relay, then open src/renderer/index.html
pnpm cli fanout --repo . --agents claude-code,codex --prompt "add input validation"
pnpm cli list --repo .
```
Agent CLIs must be installed and on `PATH`; flags per agent are in `AGENTS` (edit to taste). Agents run as plain child processes (no PTY), so interactive TUIs are not supported; use their non-interactive modes.

## Security
The relay binds to localhost and requires a shared token. `pnpm dev` prints a dashboard URL containing a random token; set `ORCA_TOKEN` to choose your own. Connections without the token are rejected. Anyone holding the token can run agents and merge branches, so keep it secret and do not expose the port to a network.
