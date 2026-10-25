import { Orchestrator } from './pty-orchestrator.js';
import { startRelay } from './relay-server.js';

const repo = process.argv[2] ?? process.cwd();
const port = Number(process.env.ORCA_PORT ?? 7420);
startRelay(new Orchestrator(repo), port);
console.log(`NexusOrca relay for ${repo} on ws://127.0.0.1:${port}`);
