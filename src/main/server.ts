import { Orchestrator } from './pty-orchestrator.js';
import { startRelay } from './relay-server.js';

const repo = process.argv[2] ?? process.cwd();
const port = Number(process.env.ORCA_PORT ?? 7420);
const relay = startRelay(new Orchestrator(repo), port);
console.log(`NexusOrca relay for ${repo} on port ${port}`);
console.log(`Desktop dashboard: src/renderer/index.html#token=${relay.token}`);
console.log(`Phone page:        http://<this-machine>:${port}/?token=${relay.token}`);
if ((process.env.ORCA_HOST ?? '127.0.0.1') !== '127.0.0.1') {
  console.warn('WARNING: listening beyond localhost over plain HTTP. Put it behind a TLS tunnel (Tailscale, Cloudflare Tunnel) before using it off your own network.');
}
