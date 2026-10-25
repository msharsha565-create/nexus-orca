import { spawn } from 'node:child_process';

const MAX_OUTPUT = 1024 * 1024;

/** Run a shell command (user-supplied test command) and capture its output. */
export function runShell(cmd: string, cwd: string, timeoutMs = 600_000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true }); // the user's own test command: sh on Unix, cmd.exe on Windows
    let output = '';
    const add = (b: Buffer) => { if (output.length < MAX_OUTPUT) output += b.toString(); };
    child.stdout!.on('data', add);
    child.stderr!.on('data', add);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, output: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}
