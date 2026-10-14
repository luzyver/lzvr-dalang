import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** One changed file of a `file_change` item. `diff` is unified-diff hunks (`@@` headers, then ` `/`+`/`-` lines). */
export interface FileDiff { path: string; kind: string; diff?: string; movePath?: string }

const MAX_DIFF = 64 * 1024; // per file: diffs live in the event log and go to every viewer

export function capDiff(diff: string): string {
  return diff.length <= MAX_DIFF ? diff : `${diff.slice(0, diff.lastIndexOf('\n', MAX_DIFF))}\n… diff truncated`;
}

/** A whole file as one hunk: every line added (or removed). */
export function wholeFile(content: string, sign: '+' | '-'): string {
  const lines = content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (content === '') return '';
  const range = `${sign === '+' ? '-0,0 +1' : '-1'},${lines.length}${sign === '+' ? '' : ' +0,0'}`;
  return capDiff(`@@ ${range} @@\n${lines.map((l) => sign + l).join('\n')}`);
}

export interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

export function fromHunks(hunks: Hunk[]): string {
  return capDiff(hunks.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`).join('\n'));
}

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

type RolloutChange = { type?: string; unified_diff?: string; content?: string; move_path?: string | null };
interface RolloutFileChange { id: string; completedAt: number; changes: Record<string, RolloutChange> }

/** The FileChange items Codex wrote into a rollout (its exec JSON only names the files), completed at or after `sinceMs`. */
export function rolloutFileChanges(file: string, sinceMs: number): RolloutFileChange[] {
  try {
    const size = statSync(file).size;
    const len = Math.min(size, 4 * 1024 * 1024); // a turn's changes are near the end
    const fd = openSync(file, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
    const out: RolloutFileChange[] = [];
    for (const line of text.split('\n')) {
      if (!line.includes('"FileChange"')) continue;
      try {
        const p = (JSON.parse(line) as { payload?: { type?: string; completed_at_ms?: number; item?: { type?: string; id?: string; changes?: Record<string, RolloutChange> } } }).payload;
        const item = p?.item;
        if (p?.type !== 'item_completed' || item?.type !== 'FileChange' || !item.id || !item.changes) continue;
        if ((p.completed_at_ms ?? 0) < sinceMs) continue;
        out.push({ id: item.id, completedAt: p.completed_at_ms ?? 0, changes: item.changes });
      } catch { /* a line cut by the tail read */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Adds diffs to the `changes` of a Codex file_change item from the matching rollout entry: the oldest one not yet
 * `used` that touched exactly the same files. Returns null if none is there (yet).
 */
export function codexDiffs(changes: FileDiff[], entries: RolloutFileChange[], used: Set<string>): FileDiff[] | null {
  const want = changes.map((c) => norm(c.path)).sort().join('\n');
  const hit = entries.find((e) => !used.has(e.id) && Object.keys(e.changes).map(norm).sort().join('\n') === want);
  if (!hit) return null;
  used.add(hit.id);
  const byPath = new Map(Object.entries(hit.changes).map(([p, c]) => [norm(p), c]));
  return changes.map((c) => {
    const r = byPath.get(norm(c.path))!;
    const diff = r.type === 'update' ? capDiff((r.unified_diff ?? '').replace(/\n$/, ''))
      : r.type === 'add' ? wholeFile(r.content ?? '', '+')
        : r.type === 'delete' ? wholeFile(r.content ?? '', '-') : undefined;
    return { ...c, ...(diff !== undefined && { diff }), ...(r.move_path && { movePath: r.move_path }) };
  });
}
