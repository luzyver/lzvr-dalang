import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export type CodexEvent = { type: string; [k: string]: unknown };

/** Parsed events carry the exact line Codex printed under this key, so storage can keep it unmodified. */
export const RAW = Symbol('raw');

export interface TurnOpts {
  command?: string[];
  env?: Record<string, string>;
  home: string;
  cwd: string;
  sandbox: string;
  threadId?: string | null;
  prompt: string;
  images?: string[];
  /** Extra `codex exec` options (e.g. `-c key=value` config overrides), placed before `resume`. */
  extraArgs?: string[];
  signal?: AbortSignal;
  /** ms to wait after SIGTERM before SIGKILL (default 5000). */
  killGraceMs?: number;
}

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

/** `-i` is variadic in the Codex CLI, so images go first and are followed directly by `--json`. */
export function buildArgs(o: Pick<TurnOpts, 'cwd' | 'sandbox' | 'threadId' | 'images' | 'extraArgs'>): string[] {
  const a = ['exec'];
  for (const img of o.images ?? []) a.push('-i', img);
  a.push('--json', '--skip-git-repo-check', '-C', o.cwd, '-s', o.sandbox, ...(o.extraArgs ?? []));
  if (o.threadId) a.push('resume', o.threadId);
  a.push('-'); // prompt is read from stdin
  return a;
}

export async function* runTurn(o: TurnOpts): AsyncGenerator<CodexEvent> {
  const [cmd, ...pre] = o.command ?? ['codex'];
  // The agent runs arbitrary commands, so it must not inherit the gateway's own secrets (LZVR_TOKEN, ...).
  const inherited = Object.entries(process.env).filter(([k]) => !k.startsWith('LZVR_'));
  const child = spawn(cmd!, [...pre, ...buildArgs(o)], {
    cwd: o.cwd,
    env: { ...Object.fromEntries(inherited), ...o.env, CODEX_HOME: o.home },
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
