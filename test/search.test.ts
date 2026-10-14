import { describe, expect, it } from 'vitest';
import { snippet } from '../src/app.js';
import { AUTH, turnsDone, until } from './helpers.js';
import { setupApp } from './setup-app.js';

describe('search', () => {
  it('finds prompts, answers and titles, with every word required', async () => {
    const t = setupApp({ FAKE_ANSWER: 'The flaky test was a race in the Postgres pool' });
    const p = (await t.app.inject({ method: 'POST', url: '/api/projects', headers: AUTH, payload: { name: 'api', path: 'proj' } })).json();
    const a = (await t.app.inject({ method: 'POST', url: `/api/projects/${p.id}/conversations`, headers: AUTH })).json();
    const b = (await t.app.inject({ method: 'POST', url: `/api/projects/${p.id}/conversations`, headers: AUTH })).json();
    await t.app.inject({ method: 'POST', url: `/api/conversations/${a.id}/prompts`, headers: AUTH, payload: { prompt: 'Why is the login test flaky?' } });
    await until(() => turnsDone(t.store, a.id, 1));
    t.store.setTitle(b.id, 'Upgrade Postgres driver');
    const search = async (q: string) => (await t.app.inject({ url: `/api/search?q=${encodeURIComponent(q)}`, headers: AUTH })).json();

    const flaky = await search('FLAKY');
    expect(flaky.map((h: any) => h.kind).sort()).toEqual(['answer', 'prompt']);
    expect(flaky.every((h: any) => h.conversation_id === a.id && h.project === 'api' && typeof h.event_id === 'number')).toBe(true);
    // the event id points at the very message in the chat's stream
    const ids = t.store.eventsAfter(a.id, 0).filter((e) => e.type === 'user.prompt').map((e) => e.id);
    expect(flaky.find((h: any) => h.kind === 'prompt').event_id).toBe(ids[0]);

    const pg = await search('postgres');
    expect(pg.map((h: any) => [h.kind, h.conversation_id])).toEqual([['title', b.id], ['answer', a.id]]);
    expect(await search('postgres login')).toEqual([]); // both words, in one message
    expect((await search('race pool')).map((h: any) => h.kind)).toEqual(['answer']);
    expect(await search('100%')).toEqual([]); // % is literal, not a wildcard
    expect((await t.app.inject({ url: '/api/search?q=%20', headers: AUTH })).statusCode).toBe(400);
  });

  it('cuts long texts around the first match', () => {
    const long = `${'a '.repeat(200)}needle ${'b '.repeat(200)}`;
    const s = snippet(long, ['needle'], 60);
    expect(s).toContain('needle');
    expect(s.startsWith('…') && s.endsWith('…')).toBe(true);
    expect(snippet('short\n text', ['x'])).toBe('short text');
  });
});
