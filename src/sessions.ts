import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SessionInfo { id: string; file: string; modified: number; cwd: string | null }

// Codex writes one `rollout-<timestamp>-<uuid>.jsonl` per session under sessions/YYYY/MM/DD/.
const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function walk(dir: string, out: string[]): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (ROLLOUT.test(e.name)) out.push(p);
  }
}

/** Best effort: the first line of a rollout normally carries the session's working directory. */
function readCwd(file: string): string | null {
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(65536);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const first = buf.toString('utf8', 0, n).split('\n', 1)[0] ?? '';
      const obj = JSON.parse(first) as { payload?: { cwd?: unknown }; cwd?: unknown };
      const cwd = obj.payload?.cwd ?? obj.cwd;
      return typeof cwd === 'string' ? cwd : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Codex sessions found under `<home>/sessions`, newest first. */
export function listSessions(home: string, limit = 100): SessionInfo[] {
  const files: string[] = [];
  walk(join(home, 'sessions'), files);
  return files
    .map((file) => ({ file, modified: statSync(file).mtimeMs, id: ROLLOUT.exec(file.split(/[\\/]/).pop()!)![1]! }))
    .sort((a, b) => b.modified - a.modified)
    .slice(0, limit)
    .map((s) => ({ ...s, cwd: readCwd(s.file) }));
}

export interface LimitWindow { label: string; usedPercent: number; resetsAt: number }

/** The rollout file of a Codex session, or null. */
export function findRollout(home: string, threadId: string): string | null {
  const files: string[] = [];
  walk(join(home, 'sessions'), files);
  return files.find((f) => f.toLowerCase().includes(threadId.toLowerCase())) ?? null;
}

const windowLabel =(minutes: number) => (minutes === 300 ? '5h' : minutes === 10080 ? '7d' : `${minutes}m`);

/**
 * The usage windows Codex last wrote into a session's rollout (its `token_count` events carry `rate_limits`).
 * ponytail: walks the sessions tree to find the file; index by id if the history gets large.
 */
export function codexLimits(home: string, threadId: string): LimitWindow[] {
  const file = findRollout(home, threadId);
  if (!file) return [];
  try {
    const size = statSync(file).size;
    const fd = openSync(file, 'r');
    try {
      const len = Math.min(size, 262144);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const line = buf.toString('utf8').split('\n').reverse().find((l) => l.includes('"rate_limits"'));
      if (!line) return [];
      const rl = (JSON.parse(line) as { payload?: { rate_limits?: Record<string, { used_percent: number; window_minutes: number; resets_at: number }> } }).payload?.rate_limits;
      return ['primary', 'secondary'].flatMap((k) => rl?.[k]
        ? [{ label: windowLabel(rl[k]!.window_minutes), usedPercent: rl[k]!.used_percent, resetsAt: rl[k]!.resets_at }] : []);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}
