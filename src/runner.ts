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

/**
 * The server's environment without its own secrets (LZVR_TOKEN, LZVR_SECRET_KEY, ...): what every CLI it starts gets
 * (an agent runs arbitrary commands, and a model list or a help text is the same binary).
 */
export function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => !e[0].startsWith('LZVR_') && e[1] !== undefined));
}

export interface ProcessOpts {
  command: string[];
  args: string[];
  env?: Record<string, string>;
  cwd: string;
  prompt: string;
  signal?: AbortSignal;
  killGraceMs?: number;
  /** ms a process may stay alive after its turn is over (one of `endTypes`) before it is killed (default 30000). */
  exitGraceMs?: number;
  /** The raw event types that say the turn is over (default Codex's turn.completed / turn.failed). */
  endTypes?: string[];
  /**
   * ms to keep reading after the process exited while something else (an orphaned grandchild) still holds its output
   * open (default 3000). Counted only while waiting for a line, so a slow reader never loses what the CLI printed.
   * New lines restart that wait, but all waits after exit add up to at most 5 graces (at least 1s): an orphan that
   * keeps logging (a dev server) cannot keep the turn open.
   */
  drainGraceMs?: number;
}

/** Run a CLI that reads the prompt on stdin and prints one JSON event per line. Shared by every backend. */
export async function* runProcess(o: ProcessOpts): AsyncGenerator<CodexEvent> {
  const [cmd, ...pre] = o.command;
  const child = spawn(cmd!, [...pre, ...o.args], {
    cwd: o.cwd,
    env: { ...inheritedEnv(), ...o.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const rl = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
  child.stdin.on('error', () => {}); // EPIPE when the process dies early
  child.stdin.end(o.prompt);

  let release = () => {};
  // After exit the drain timer runs only while waiting for a line (`pause` while one is handed to the caller).
  const grace = o.drainGraceMs ?? 3000;
  const cap = Math.max(5 * grace, 1000);
  let dead = false; // the CLI itself exited
  let reading = true; // waiting for the next line, not handing one to the caller
  let waited = 0; // ms spent waiting for lines since exit
  let armedAt = 0;
  let drainTimer: NodeJS.Timeout | undefined;
  const drain = () => {
    if (!dead || !reading || drainTimer) return;
    armedAt = performance.now();
    drainTimer = setTimeout(release, Math.max(0, Math.min(grace, cap - waited)));
    drainTimer.unref();
  };
  const pause = () => {
    reading = false;
    if (!drainTimer) return;
    clearTimeout(drainTimer);
    drainTimer = undefined;
    waited += performance.now() - armedAt;
  };
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (e) => { stderr = e.message; rl.close(); resolve(-1); });
    child.once('close', (code) => resolve(code));
    // 'close' waits for stdout/stderr to close, and an orphaned grandchild (a dev server the agent started)
    // can hold them open long after the agent is dead. Once a cancelled run is killed, stop waiting for them.
    release = () => {
      rl.close();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(child.exitCode);
    };
    // The CLI itself is gone: whatever it printed is already in the pipe, so once no line came for a while, stop.
    child.once('exit', () => { dead = true; drain(); });
  });

  let escalate: NodeJS.Timeout | undefined;
  const onAbort = () => {
    killTree(child, 'SIGTERM');
    escalate = setTimeout(() => { killTree(child, 'SIGKILL'); release(); }, o.killGraceMs ?? 5000);
    escalate.unref();
  };
  if (o.signal?.aborted) onAbort();
  else o.signal?.addEventListener('abort', onAbort, { once: true });

  // A CLI that reported its turn as over but does not exit (seen with codex after turn.completed) would keep the chat
  // "running" for good, so it gets a grace period to exit by itself and is killed after it.
  let lingered = false;
  let lingerTimer: NodeJS.Timeout | undefined;
  const endTypes = o.endTypes ?? ['turn.completed', 'turn.failed'];
  try {
    for await (const line of rl) {
      pause();
      if (!line.trim()) { reading = true; drain(); continue; }
      let ev: CodexEvent;
      try {
        ev = JSON.parse(line) as CodexEvent;
        if (typeof ev.type !== 'string') throw new Error('not an event');
        Object.defineProperty(ev, RAW, { value: line });
      } catch {
        ev = { type: 'raw', line };
      }
      yield ev;
      reading = true;
      drain();
      if (endTypes.includes(ev.type) && !lingerTimer) {
        lingerTimer = setTimeout(() => { lingered = true; killTree(child, 'SIGKILL'); release(); }, o.exitGraceMs ?? 30_000);
        lingerTimer.unref();
      }
    }
    const code = await exited;
    if (code !== 0 && !lingered) yield { type: 'process.exit', code, stderr };
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    clearTimeout(escalate);
    clearTimeout(lingerTimer);
    clearTimeout(drainTimer);
    if (child.exitCode === null && child.signalCode === null) killTree(child, 'SIGKILL');
  }
}
