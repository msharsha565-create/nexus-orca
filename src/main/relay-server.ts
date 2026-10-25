import { WebSocketServer, type WebSocket } from 'ws';
import { Orchestrator, type AgentEvent } from './pty-orchestrator.js';

interface Request { id?: number; method: string; params?: any }

/** JSON-RPC-ish WebSocket relay so a companion client can steer worktrees. */
export function startRelay(orch: Orchestrator, port = 7420, host = '127.0.0.1') {
  const wss = new WebSocketServer({ port, host });
  const broadcast = (msg: unknown) => {
    const s = JSON.stringify(msg);
    wss.clients.forEach((c) => c.readyState === c.OPEN && c.send(s));
  };
  orch.on('event', (e: AgentEvent) => broadcast({ event: e.type, ...e }));

  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', async (raw) => {
      let req: Request;
      try { req = JSON.parse(raw.toString()); } catch { return ws.send(JSON.stringify({ error: 'invalid json' })); }
      try {
        let result: unknown;
        switch (req.method) {
          case 'list': result = await orch.manager.list(); break;
          case 'fanout': result = await orch.fanout(req.params.agents, req.params.prompt); break;
          case 'diff': result = await orch.manager.diff(await find(orch, req.params.branch)); break;
          case 'stats': result = await orch.manager.stats(await find(orch, req.params.branch)); break;
          case 'steer': result = orch.steer(req.params.branch, req.params.text); break;
          case 'merge': await orch.manager.merge(await find(orch, req.params.branch)); result = true; break;
          default: throw new Error(`unknown method ${req.method}`);
        }
        ws.send(JSON.stringify({ id: req.id, result }));
      } catch (e) {
        ws.send(JSON.stringify({ id: req.id, error: (e as Error).message }));
      }
    });
  });
  return wss;
}

async function find(orch: Orchestrator, branch: string) {
  const wt = (await orch.manager.list()).find((w) => w.branch === branch);
  if (!wt) throw new Error(`no worktree for ${branch}`);
  return wt;
}
