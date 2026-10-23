import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexSessionInfo } from '../src/sessions.js';

const id = '11111111-2222-4333-8444-555555555555';
const sample = (tokens: number) => ({ type: 'event_msg', payload: { type: 'token_count', info: {
  last_token_usage: { total_tokens: tokens, input_tokens: tokens - 10, output_tokens: 10, cached_input_tokens: tokens - 20 },
  total_token_usage: { input_tokens: 50_000_000 }, model_context_window: 200_000,
}, rate_limits: { primary: { used_percent: 25, window_minutes: 300, resets_at: 9999999999 } } } });

function rollout(rows: unknown[]) {
  const home = mkdtempSync(join(tmpdir(), 'dalang-context-'));
  mkdirSync(join(home, 'sessions'));
  writeFileSync(join(home, 'sessions', `rollout-test-${id}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return home;
}

describe('Codex active context samples', () => {
  it('uses the last request including output, without adding cache or session totals again', () => {
    const home = rollout([sample(150_000), sample(45_000)]);
    expect(codexSessionInfo(home, id)).toEqual({ context: { tokens: 45_000, window: 200_000 }, compactedAt: null,
      limits: [{ label: '5h', usedPercent: 25, resetsAt: 9999999999 }] });
  });

  it('invalidates pre-compaction samples and reports the native compaction boundary', () => {
    const at = '2026-10-23T10:00:00.000Z';
    const home = rollout([sample(150_000), { type: 'compacted', timestamp: at }]);
    expect(codexSessionInfo(home, id).context).toBeNull();
    expect(codexSessionInfo(home, id).compactedAt).toBe(at);
    const fresh = rollout([sample(150_000), { type: 'compacted', timestamp: at }, sample(12_000)]);
    expect(codexSessionInfo(fresh, id).context).toEqual({ tokens: 12_000, window: 200_000 });
  });

  it('reads only a bounded tail and tolerates a partial first line or missing file', () => {
    const home = rollout([{ type: 'tool-output', text: 'large output '.repeat(50_000) }, sample(22_000)]);
    expect(codexSessionInfo(home, id).context?.tokens).toBe(22_000);
    expect(codexSessionInfo(home, '00000000-0000-0000-0000-000000000000')).toEqual({ limits: [], context: null, compactedAt: null });
  });
});
