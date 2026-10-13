import { runProcess, type CodexEvent } from './runner.js';

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

/** `-i` is variadic in the Codex CLI, so images go first and are followed directly by `--json`. */
export function buildArgs(o: Pick<TurnOpts, 'cwd' | 'sandbox' | 'threadId' | 'images' | 'extraArgs'>): string[] {
  const a = ['exec'];
  for (const img of o.images ?? []) a.push('-i', img);
  a.push('--json', '--skip-git-repo-check', '-C', o.cwd, '-s', o.sandbox, ...(o.extraArgs ?? []));
  if (o.threadId) a.push('resume', o.threadId);
  a.push('-'); // prompt is read from stdin
  return a;
}

export function runTurn(o: TurnOpts): AsyncGenerator<CodexEvent> {
  return runProcess({
    command: o.command ?? ['codex'], args: buildArgs(o), env: { ...o.env, CODEX_HOME: o.home },
    cwd: o.cwd, prompt: o.prompt, signal: o.signal, killGraceMs: o.killGraceMs,
  });
}
