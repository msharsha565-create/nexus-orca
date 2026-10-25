import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Orchestrator, type AgentEvent } from './pty-orchestrator.js';

interface Request { id?: number; method: string; params?: any }

export interface Relay { wss: WebSocketServer; server: http.Server; token: string; close(): void }

// Resolves to src/renderer from both src/main (dev) and dist/main (built).
const MOBILE_PAGE = new URL('../../src/renderer/mobile.html', import.meta.url);

/**
 * WebSocket relay so a companion client (the phone page below, or your own) can steer worktrees.
 * Plain HTTP GET / serves the phone page. Every WebSocket connection must carry ?token=.
 */
export function startRelay(
  orch: Orchestrator,
  port = 7420,
  host = process.env.ORCA_HOST ?? '127.0.0.1',
  token = process.env.ORCA_TOKEN ?? randomBytes(24).toString('hex'),
): Relay {
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== '/' && path !== '/m') { res.writeHead(404).end('not found'); return; }
    try {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:",
        'Referrer-Policy': 'no-referrer',
      }).end(await fs.readFile(MOBILE_PAGE));
    } catch { res.writeHead(500).end('phone page missing'); }
  });

  const wss = new WebSocketServer({
    server,
    verifyClient: ({ req }: { req: http.IncomingMessage }) => {
      const given = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '';
      const a = Buffer.from(given);
      const b = Buffer.from(token);
      return a.length === b.length && timingSafeEqual(a, b);
    },
    maxPayload: 1024 * 1024,
  });
  server.listen(port, host);

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
  return { wss, server, token, close: () => { wss.close(); server.close(); } };
}

async function find(orch: Orchestrator, branch: string) {
  const wt = (await orch.manager.list()).find((w) => w.branch === branch);
  if (!wt) throw new Error(`no worktree for ${branch}`);
  return wt;
}
