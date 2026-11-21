// Runs api, fetch-worker and web together with prefixed output.
// Replaces `concurrently`, which looks up "cmd.exe" via PATH and fails when
// C:\Windows\System32 is missing from PATH. Node's `shell: true` uses %ComSpec% instead.
import { spawn } from 'node:child_process';
import path from 'node:path';

const SERVICES = [
  { name: 'api', color: 34, script: 'dev:api' },
  { name: 'fetch', color: 32, script: 'dev:fetch-worker' },
  { name: 'web', color: 35, script: 'dev:web' },
];

const isWindows = process.platform === 'win32';
const children = [];
let shuttingDown = false;

function prefixLines(stream, out, prefix) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) out.write(`${prefix}${line}\n`);
  });
  stream.on('end', () => buffer && out.write(`${prefix}${buffer}\n`));
}

/** Kills the whole process tree (npm → cmd → tsx → node), not just the shell. */
function killTree(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (isWindows) {
    // Full path: works even when System32 is not on PATH.
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  setTimeout(() => process.exit(code), 1000);
}

for (const service of SERVICES) {
  const prefix = `\x1b[${service.color}m[${service.name}]\x1b[0m `;
  const child = spawn(`npm run ${service.script}`, {
    shell: true,
    detached: !isWindows, // own process group on Unix so killTree can signal it
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  prefixLines(child.stdout, process.stdout, prefix);
  prefixLines(child.stderr, process.stderr, prefix);
  child.on('error', (err) => {
    process.stderr.write(`${prefix}failed to start: ${err.message}\n`);
    shutdown(1);
  });
  child.on('exit', (code) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix}exited with code ${code} — stopping the others\n`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
