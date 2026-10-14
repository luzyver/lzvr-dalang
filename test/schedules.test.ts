import { describe, expect, it } from 'vitest';
import { Scheduler } from '../src/schedules.js';
import { AUTH, turnsDone, until } from './helpers.js';
import { bearer, mkUser, setupApp } from './setup-app.js';

async function chat() {
  const t = setupApp();
  const p = (await t.app.inject({ method: 'POST', url: '/api/projects', headers: AUTH, payload: { name: 'p', path: 'proj' } })).json();
  const conv = (await t.app.inject({ method: 'POST', url: `/api/projects/${p.id}/conversations`, headers: AUTH })).json();
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers = AUTH) =>
    t.app.inject({ method, url, headers, payload: payload as Record<string, unknown> | undefined });
  return { ...t, project: p, conv, call };
}

describe('scheduled prompts', () => {
  it('creates, lists, edits and deletes a schedule', async () => {
    const t = await chat();
    const r = await t.call('POST', `/api/conversations/${t.conv.id}/schedules`, { prompt: ' check deps ', cron: '0 9 * * 1-5' });
    expect(r.statusCode).toBe(201);
    const s = r.json();
    expect(s).toMatchObject({ prompt: 'check deps', cron: '0 9 * * 1-5', enabled: true, created_by: 'owner', project: 'p', last_run_at: null });
    expect(s.next_run_at).toBeGreaterThan(Date.now());
    expect(new Date(s.next_run_at).getHours()).toBe(9);

    expect((await t.call('GET', `/api/conversations/${t.conv.id}/schedules`)).json()).toHaveLength(1);
    expect((await t.call('GET', '/api/schedules')).json()).toHaveLength(1);

    const off = (await t.call('PATCH', `/api/schedules/${s.id}`, { enabled: false })).json();
    expect(off).toMatchObject({ enabled: false, next_run_at: null });
    const on = (await t.call('PATCH', `/api/schedules/${s.id}`, { enabled: true, cron: '@hourly' })).json();
    expect(on).toMatchObject({ enabled: true, cron: '@hourly' });
    expect(new Date(on.next_run_at).getMinutes()).toBe(0);

    expect((await t.call('DELETE', `/api/schedules/${s.id}`)).statusCode).toBe(204);
    expect((await t.call('GET', '/api/schedules')).json()).toEqual([]);
  });

  it('refuses a bad expression, and previews a good one', async () => {
    const t = await chat();
    const bad = await t.call('POST', `/api/conversations/${t.conv.id}/schedules`, { prompt: 'x', cron: '61 * * * *' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/minute/);
    expect((await t.call('POST', `/api/conversations/${t.conv.id}/schedules`, { prompt: 'x', cron: '0 0 31 2 *' })).json().error).toMatch(/never/);
    expect((await t.call('GET', '/api/schedules/preview?cron=nope')).statusCode).toBe(400);
    const p = (await t.call('GET', `/api/schedules/preview?cron=${encodeURIComponent('*/5 * * * *')}`)).json();
    expect(p.next).toHaveLength(3);
    expect(p.next[1] - p.next[0]).toBe(5 * 60_000);
    expect(typeof p.timeZone).toBe('string');
  });

  it('queues the prompt when due, once, and moves on to the next time', async () => {
    const t = await chat();
    const s = (await t.call('POST', `/api/conversations/${t.conv.id}/schedules`, { prompt: 'nightly check', cron: '0 3 * * *' })).json();
    const scheduler = new Scheduler(t.store, t.dispatcher);
    expect(scheduler.tick(s.next_run_at - 1)).toEqual([]);

    expect(scheduler.tick(s.next_run_at)).toEqual([s.id]);
    await until(() => turnsDone(t.store, t.conv.id, 1));
    expect(t.store.listTurns(t.conv.id)[0]!.prompt).toBe('nightly check');
    const after = t.store.getSchedule(s.id)!;
    expect(after.last_run_at).toBe(s.next_run_at);
    expect(after.next_run_at).toBe(s.next_run_at + 86_400_000 + (new Date(s.next_run_at + 86_400_000).getTimezoneOffset() - new Date(s.next_run_at).getTimezoneOffset()) * 60_000);
    // Overdue by days (the gateway was down): one run, not one per missed day.
    expect(scheduler.tick(s.next_run_at + 5 * 86_400_000)).toEqual([s.id]);
    expect(t.store.getSchedule(s.id)!.next_run_at).toBeGreaterThan(s.next_run_at + 5 * 86_400_000);
  });

  it('does not pile up copies while the chat is busy, and Run now queues on demand', async () => {
    const t = await chat();
    const s = (await t.call('POST', `/api/conversations/${t.conv.id}/schedules`, { prompt: 'again', cron: '* * * * *' })).json();
    t.store.enqueue(t.conv.id, 'again', []); // a copy still waiting (the dispatcher was not kicked)
    expect(new Scheduler(t.store, t.dispatcher).tick(s.next_run_at)).toEqual([]);
    expect((await t.call('POST', `/api/schedules/${s.id}/run`)).statusCode).toBe(409);
    t.store.popQueue(t.conv.id);
    expect((await t.call('POST', `/api/schedules/${s.id}/run`)).statusCode).toBe(202);
    await until(() => turnsDone(t.store, t.conv.id, 1));
  });

  it('is open to devs and goes away with its chat', async () => {
    const t = await chat();
    const dev = await mkUser(t, 'dana', 'dev');
    const r = await t.call('POST', `/api/conversations/${t.conv.id}/schedules`, { prompt: 'x', cron: '@daily' }, bearer(dev.token));
    expect(r.json().created_by).toBe('dana');
    await t.call('DELETE', `/api/conversations/${t.conv.id}`);
    expect(t.store.listSchedules()).toEqual([]);
  });
});
