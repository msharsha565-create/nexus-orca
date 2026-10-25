import { Orchestrator } from './pty-orchestrator.js';
import { startRelay } from './relay-server.js';

const repo = process.argv[2] ?? process.cwd();
const port = Number(process.env.ORCA_PORT ?? 7420);
const relay = startRelay(new Orchestrator(repo), port) as ReturnType<typeof startRelay> & { token: string };
console.log(`NexusOrca relay for ${repo} on ws://127.0.0.1:${port}`);
console.log(`Open the dashboard with: src/renderer/index.html#token=${relay.token}`);
