import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export type CodexEvent = { type: string; [k: string]: unknown };

/** Parsed events carry the exact line Codex printed under this key, so storage can keep it unmodified. */
export const RAW = Symbol('raw');

/** Kill the whole process tree: codex may run shell commands or be launched through a wrapper. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, signal); // child leads its own process group (detached)
  } catch {
    child.kill(signal);
  }
}

export interface ProcessOpts {
  command: string[];
  args: string[];
  env?: Record<string, string>;
  cwd: string;
  prompt: string;
  signal?: AbortSignal;
  killGraceMs?: number;
}

/** Run a CLI that reads the prompt on stdin and prints one JSON event per line. Shared by every backend. */
export async function* runProcess(o: ProcessOpts): AsyncGenerator<CodexEvent> {
  const [cmd, ...pre] = o.command;
  // The agent runs arbitrary commands, so it must not inherit the gateway's own secrets (LZVR_TOKEN, ...).
  const inherited = Object.entries(process.env).filter(([k]) => !k.startsWith('LZVR_'));
  const child = spawn(cmd!, [...pre, ...o.args], {
    cwd: o.cwd,
    env: { ...Object.fromEntries(inherited), ...o.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const rl = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
  child.stdin.on('error', () => {}); // EPIPE when the process dies early
  child.stdin.end(o.prompt);

  let escalate: NodeJS.Timeout | undefined;
  const onAbort = () => {
    killTree(child, 'SIGTERM');
    escalate = setTimeout(() => killTree(child, 'SIGKILL'), o.killGraceMs ?? 5000);
    escalate.unref();
  };
  if (o.signal?.aborted) onAbort();
  else o.signal?.addEventListener('abort', onAbort, { once: true });

  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (e) => { stderr = e.message; rl.close(); resolve(-1); });
    child.once('close', (code) => resolve(code));
  });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let ev: CodexEvent;
      try {
        ev = JSON.parse(line) as CodexEvent;
        if (typeof ev.type !== 'string') throw new Error('not an event');
        Object.defineProperty(ev, RAW, { value: line });
      } catch {
        ev = { type: 'raw', line };
      }
      yield ev;
    }
    const code = await exited;
    if (code !== 0) yield { type: 'process.exit', code, stderr };
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    clearTimeout(escalate);
    if (child.exitCode === null && child.signalCode === null) killTree(child, 'SIGKILL');
  }
}
