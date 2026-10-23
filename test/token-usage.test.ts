import { describe, expect, it } from 'vitest';
import { summarizeUsage } from '../src/token-usage.js';

const event = (id: number, type: string, data: Record<string, unknown>) => ({ id, type, payload: JSON.stringify({ type, ...data }) });
const thread = (id: number, name: string) => event(id, 'thread.started', { thread_id: name });
const codex = (id: number, input: number, output: number, cached = 0) => event(id, 'turn.completed', {
  usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached },
});

describe('reported token accounting', () => {
  it('converts the actual cumulative screenshot counters to one turn without double counting cache', () => {
    const result = summarizeUsage([
      thread(1, 'codex-session'), codex(2, 7684476, 36917, 7366528),
      thread(3, 'codex-session'), codex(4, 7871037, 37019, 7526784),
    ]);
    expect(result.byEvent.get(4)).toEqual({ input_tokens: 186561, output_tokens: 102, cached_input_tokens: 160256 });
    expect(result.total).toEqual({ input_tokens: 7871037, output_tokens: 37019, cached_input_tokens: 7526784 });
  });

  it('keeps independent session baselines and sums sessions when agents switch', () => {
    const result = summarizeUsage([
      thread(1, 'codex-a'), codex(2, 100, 20, 40),
      thread(3, 'claude-b'), event(4, 'turn.completed', { usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 } }),
      thread(5, 'claude-b'), event(6, 'turn.completed', { usage: { input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 60, cache_creation_input_tokens: 0 } }),
      thread(7, 'codex-new'), codex(8, 30, 6, 10),
      thread(9, 'codex-a'), codex(10, 140, 25, 60),
    ]);
    expect(result.byEvent.get(6)).toEqual({ input_tokens: 68, output_tokens: 2, cached_input_tokens: 60, cache_write_input_tokens: 0 });
    expect(result.byEvent.get(8)).toEqual({ input_tokens: 30, output_tokens: 6, cached_input_tokens: 10 });
    expect(result.byEvent.get(10)).toEqual({ input_tokens: 40, output_tokens: 5, cached_input_tokens: 20 });
    expect(result.total).toEqual({ input_tokens: 303, output_tokens: 36, cached_input_tokens: 180, cache_write_input_tokens: 5 });
  });

  it('handles counter resets and repeated snapshots without negative or duplicate counts', () => {
    const result = summarizeUsage([thread(1, 'same'), codex(2, 100, 20, 50), codex(3, 100, 20, 50), codex(4, 10, 2, 4), codex(5, 15, 3, 5)]);
    expect(result.byEvent.get(3)).toEqual({ input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 });
    expect(result.byEvent.get(4)).toEqual({ input_tokens: 10, output_tokens: 2, cached_input_tokens: 4 });
    expect(result.total).toEqual({ input_tokens: 115, output_tokens: 23, cached_input_tokens: 55 });
  });

  it('respects explicitly marked per-turn usage and preserves old Claude reports', () => {
    const result = summarizeUsage([
      thread(1, 'session'),
      event(2, 'turn.completed', { usage_scope: 'turn', usage: { input_tokens: 20, output_tokens: 3, cached_input_tokens: 10 } }),
      event(3, 'turn.completed', { usage_scope: 'turn', usage: { input_tokens: 30, output_tokens: 4, cached_input_tokens: 20 } }),
      event(4, 'turn.completed', { usage: { input_tokens: 5, output_tokens: 2 } }),
    ]);
    expect(result.total).toEqual({ input_tokens: 55, output_tokens: 9, cached_input_tokens: 30 });
  });

  it('ignores missing/invalid reports and does not invent a total for an empty chat', () => {
    const result = summarizeUsage([
      thread(1, 'session'), event(2, 'turn.completed', {}), event(3, 'turn.completed', { usage: { input_tokens: -1 } }),
      { id: 4, type: 'turn.completed', payload: 'invalid JSON' },
      event(5, 'turn.failed', { usage: { input_tokens: 300 } }),
    ]);
    expect(result.total).toBeNull();
    expect(result.byEvent.size).toBe(0);
  });
});
