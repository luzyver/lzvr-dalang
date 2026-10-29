import { describe, expect, it } from 'vitest';
import { buildReviewPrompt, isEarlierReview, parseVerdict, promptReview, REVIEWER_DEFAULTS, REVIEWER_GUIDE, REVIEWER_ROLE, reviewerMessage, reviewKey } from '../src/reviewer.js';
import { Store } from '../src/store.js';

describe('reviewer', () => {
  it('passes unless the first line says ISSUES, also in markdown', () => {
    expect(parseVerdict('LGTM')).toEqual({ ok: true, issues: '' });
    expect(parseVerdict('Looks fine, but ISSUES may come later')).toEqual({ ok: true, issues: '' });
    expect(parseVerdict('**ISSUES**\n1. src/a.ts:3 off by one\n')).toEqual({ ok: false, issues: '1. src/a.ts:3 off by one' });
    expect(parseVerdict('  ## Issues\n\n1. x')).toEqual({ ok: false, issues: '1. x' });
    expect(parseVerdict('ISSUES')).toEqual({ ok: false, issues: '' });
  });

  it('builds the prompt from the request, the answer and the change, with the built-in or own guide', () => {
    const base = { request: 'add a button', answer: 'done', base: 't1-before', after: 't1-after', diffs: ['### a.ts\n+x'], round: 1,
      key: reviewKey({ base: 't1-before', rounds: 1 }) };
    const files = [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', from: 'c.ts', status: 'R' }] as never;
    const p = buildReviewPrompt({ ...base, files });
    expect(p).toContain(REVIEWER_GUIDE);
    expect(p).toContain('add a button');
    expect(p).toContain('M a.ts\nR c.ts -> b.ts');
    expect(p).toContain('git diff t1-before t1-after');
    expect(p).toContain('### a.ts\n+x');
    expect(buildReviewPrompt({ ...base, files, guide: 'Only check tests.' })).not.toContain(REVIEWER_GUIDE);
    expect(promptReview(p)).toEqual({ round: 1, key: 't1-before/1' });
    expect(promptReview('[Reviewer] something else')).toBeNull();
  });

  it('sends the issues back as a [Reviewer] message', () => {
    const m = reviewerMessage({ reviewer: 'r1', issues: '1. bug', round: 1, maxRounds: 2 });
    expect(m.startsWith('[Reviewer]')).toBe(true);
    expect(m).toContain('round 1 of 2');
    expect(m).toContain('1. bug');
    expect(m).not.toContain('still applies');
    const late = reviewerMessage({ reviewer: 'r1', issues: '1. bug', round: 1, maxRounds: 2, earlier: true });
    expect(late).toContain('from before the latest request');
    expect(late).toContain('still applies');
    expect(isEarlierReview(late)).toBe(true);
    expect(isEarlierReview(m)).toBe(false);
  });

  it('stores the policy off by default and does not count reviewers as sub-agents', () => {
    const store = new Store();
    expect(store.getReviewerPolicy()).toEqual(REVIEWER_DEFAULTS);
    store.setReviewerPolicy({ ...REVIEWER_DEFAULTS, enabled: true, maxRounds: 3 });
    expect(store.getReviewerPolicy()).toMatchObject({ enabled: true, maxRounds: 3 });
    const project = store.createProject('p', '/w/p');
    const main = store.createConversation(project.id);
    store.createConversation(project.id, undefined, main.id);
    const rev = store.createConversation(project.id, undefined, main.id);
    store.setRole(rev.id, REVIEWER_ROLE);
    expect(store.countChildren(main.id)).toBe(1);
    expect(store.getConversation(rev.id)?.role).toBe(REVIEWER_ROLE);
  });
});

describe('review state', () => {
  it('is kept in the database per chat and dropped with the chat', () => {
    const store = new Store();
    const project = store.createProject('p', '/w/p');
    const main = store.createConversation(project.id);
    expect(store.getReview(main.id)).toBeNull();
    const state = { request: 'add a button', base: 't1-before', rounds: 1, reviewer: 'r1' };
    store.setReview(main.id, state);
    expect(store.getReview(main.id)).toEqual(state);
    store.deleteConversation(main.id);
    expect(store.getReview(main.id)).toBeNull();
  });
});
