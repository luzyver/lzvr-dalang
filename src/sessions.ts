import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextUsage } from './context.js';

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
  return codexSessionInfo(home, threadId).limits;
}

export interface CodexSessionInfo { limits: LimitWindow[]; context: ContextUsage | null; compactedAt: string | null }

/** The last inference's active context, separate from total_token_usage (which accumulates across the session). */
export function codexSessionInfo(home: string, threadId: string): CodexSessionInfo {
  const empty: CodexSessionInfo = { limits: [], context: null, compactedAt: null };
  const file = findRollout(home, threadId);
  if (!file) return empty;
  try {
    const size = statSync(file).size;
    const fd = openSync(file, 'r');
    try {
      const len = Math.min(size, 262144);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const result: CodexSessionInfo = { ...empty };
      let contextSeen = false;
      let limitsSeen = false;
      for (const line of buf.toString('utf8').split('\n').reverse()) {
        if (!line.includes('"token_count"') && !line.includes('"compacted"')) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; } // the tail may start in the middle of a long line
        if (row.type === 'compacted') {
          if (!contextSeen) contextSeen = true; // metrics before compaction no longer describe the active context
          if (!result.compactedAt && typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp))) result.compactedAt = row.timestamp;
        }
        if (row.type !== 'event_msg' || row.payload?.type !== 'token_count') continue;
        const info = row.payload.info;
        const last = info?.last_token_usage;
        if (!contextSeen && last) {
          const tokens = last.total_tokens ?? (typeof last.input_tokens === 'number' && typeof last.output_tokens === 'number'
            ? last.input_tokens + last.output_tokens : undefined);
          if (Number.isFinite(tokens) && tokens >= 0) {
            const window = info.model_context_window;
            result.context = { tokens, ...(Number.isFinite(window) && window > 0 && { window }) };
            contextSeen = true;
          }
        }
        if (!limitsSeen && 'rate_limits' in row.payload) {
          const rl = row.payload.rate_limits;
          result.limits = ['primary', 'secondary'].flatMap((k) => rl?.[k]
            ? [{ label: windowLabel(rl[k].window_minutes), usedPercent: rl[k].used_percent, resetsAt: rl[k].resets_at }] : []);
          limitsSeen = true;
        }
      }
      return result;
    } finally {
      closeSync(fd);
    }
  } catch {
    return empty;
  }
}
