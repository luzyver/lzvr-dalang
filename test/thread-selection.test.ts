import { describe, expect, it } from 'vitest';
// @ts-expect-error The panel modules are plain JavaScript.
import { ThreadModel } from '../public/js/stream.js';

const event = (id: number, data: Record<string, unknown>) => ({ id, type: 'turn.selection', data });

describe('selection changes in the chat thread', () => {
  it('shows native compaction as a continuation note and ignores context telemetry as a chat message', () => {
    const thread = new ThreadModel();
    thread.apply([{ id: 1, type: 'context.compacting', data: {} }]);
    expect(thread.live.label).toBe('Compacting context');
    thread.apply([{ id: 2, type: 'context.compacted', data: {} }, { id: 3, type: 'context.usage', data: { tokens: 12000 } }]);
    expect(thread.live).toBeNull();
    expect(thread.blocks).toMatchObject([{ type: 'note', text: 'Context compacted; continuing in the same session. Full history remains available.' }]);
  });

  it('shows the server-computed turn count instead of the cumulative session count on paged history', () => {
    const thread = new ThreadModel();
    const turnUsage = { input_tokens: 186561, output_tokens: 102, cached_input_tokens: 160256 };
    thread.apply([
      { id: 20, type: 'item.completed', data: { item: { type: 'agent_message', text: 'answer' } } },
      { id: 21, type: 'turn.completed', data: { usage: { input_tokens: 7871037, output_tokens: 37019 }, turn_usage: turnUsage } },
    ]);
    expect(thread.blocks[0].usage).toEqual(turnUsage);
  });

  it('shows both changes before the prompt without needing earlier history pages', () => {
    const thread = new ThreadModel();
    thread.apply([
      event(20, { previous: { backend: 'codex', model: 'gpt-small' }, current: { backend: 'claude', model: 'sonnet' } }),
      { id: 21, type: 'user.prompt', data: { text: 'Continue' } },
    ]);
    expect(thread.blocks).toMatchObject([
      { type: 'note', text: 'Agent changed: Codex → Claude Code · Model changed: gpt-small → sonnet', tone: 'dim' },
      { type: 'user', text: 'Continue' },
    ]);
  });

  it('keeps first and unchanged turns quiet and labels CLI defaults clearly', () => {
    const thread = new ThreadModel();
    thread.apply([
      event(1, { current: { backend: 'codex', model: '' } }),
      event(2, { previous: { backend: 'codex', model: '' }, current: { backend: 'codex', model: '' } }),
      event(3, { previous: { backend: 'codex', model: 'gpt-big' }, current: { backend: 'codex', model: '' } }),
      event(4, { previous: { backend: 'codex', model: '' }, current: { backend: 'claude', model: '' } }),
    ]);
    expect(thread.blocks).toMatchObject([
      { type: 'note', text: 'Model changed: gpt-big → Codex default' },
      { type: 'note', text: 'Agent changed: Codex → Claude Code' },
    ]);
  });
});
