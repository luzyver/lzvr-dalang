import { describe, expect, it } from 'vitest';
import { withHistory } from '../src/chat-context.js';

const recovery = { conversationId: 'chat-id', beforeTurn: 150 };

describe('history handoff', () => {
  it('passes the current request through unchanged when there is no earlier session', () => {
    expect(withHistory([], 'new request', recovery)).toBe('new request');
  });

  it('keeps the original goal, recent corrections and a relevant older exchange within 12k characters', () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({
      id: i * 3 + 1,
      prompt: `Task ${i} ${'background '.repeat(300)}`,
      answer: `Result ${i} ${'details '.repeat(800)}`,
    }));
    turns[0]!.prompt = 'ORIGINAL GOAL: keep exports compatible. ' + turns[0]!.prompt;
    turns[5]!.prompt = 'PostgreSQL indexing constraint: use the existing composite index. ' + turns[5]!.prompt;
    turns[29]!.answer += 'LATEST CORRECTION: no new columns.';
    const prompt = 'Continue PostgreSQL indexing. ' + 'current request must be intact '.repeat(1000);
    const result = withHistory(turns, prompt, recovery);
    expect(result.length - prompt.length).toBeLessThanOrEqual(12_000);
    expect(result).toContain('ORIGINAL GOAL');
    expect(result).toContain('LATEST CORRECTION: no new columns.');
    expect(result).toContain('### Turn 29 (stored turn 85)');
    expect(result).toContain('### Turn 30 (stored turn 88)');
    expect(result).toContain('PostgreSQL indexing constraint');
    expect(result).not.toContain('### Turn 10 ');
    expect(result).toContain('messages_only=true');
    expect(result).toContain('conversation_id="chat-id"');
    expect(result).toContain('before_turn=150');
    expect(result.endsWith(`New request:\n${prompt}`)).toBe(true);
    expect(result.indexOf('### Turn 6')).toBeLessThan(result.indexOf('### Turn 29'));
    expect(result.length - prompt.length).toBeLessThan((withHistory(turns, prompt).length - prompt.length) * .4);
  });

  it('preserves short exchanges verbatim and labels an unanswered turn', () => {
    const result = withHistory([{ id: 1, prompt: 'first', answer: 'done' }, { id: 3, prompt: 'next', answer: '' }], 'continue', recovery);
    expect(result).toContain('Asked:\nfirst\n\nAnswered:\ndone');
    expect(result).toContain('Asked:\nnext\n\nAnswered:\n(no answer)');
    expect(result).not.toContain('[...excerpt...]');
  });

  it('keeps the larger existing fallback when the session has no history retrieval tools', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({ prompt: `question ${i}`, answer: 'a'.repeat(4000) }));
    const result = withHistory(turns, 'continue');
    expect(result.length).toBeGreaterThan(30_000);
    expect(result).toContain('Turn 20');
    expect(result).not.toContain('messages_only');
    expect(result.endsWith('New request:\ncontinue')).toBe(true);
  });
});
