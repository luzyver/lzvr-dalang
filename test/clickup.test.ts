import { describe, expect, it } from 'vitest';
import { isOvertime, localParts, parseWorkHours, startOfDay } from '../src/clickup.js';
import { fakeClient, wib } from './fake-clickup.js';

describe('time helpers', () => {
  it('parses work hours and rejects nonsense', () => {
    expect(parseWorkHours('08:30-17:00')).toEqual({ start: 510, end: 1020 });
    for (const bad of ['9-5', '18:00-09:00', '09:00-25:00', '09:75-10:00']) expect(() => parseWorkHours(bad)).toThrow();
  });

  it('finds local midnight and wall-clock time in a zone', () => {
    expect(startOfDay('2026-10-08', 'Asia/Jakarta')).toBe(Date.parse('2026-10-07T17:00:00Z'));
    expect(startOfDay('2026-03-29', 'Europe/Amsterdam')).toBe(Date.parse('2026-03-28T23:00:00Z')); // DST starts that day
    expect(localParts(wib('2026-10-08T20:30:00'), 'Asia/Jakarta')).toMatchObject({ date: '2026-10-08', time: '20:30', weekday: 'Thu' });
  });

  it('counts evenings, early mornings and weekends as overtime', () => {
    const h = parseWorkHours('09:00-18:00');
    expect(isOvertime('Thu', 10 * 60, h)).toBe(false);
    expect(isOvertime('Thu', 18 * 60, h)).toBe(true);
    expect(isOvertime('Thu', 8 * 60 + 59, h)).toBe(true);
    expect(isOvertime('Sat', 10 * 60, h)).toBe(true);
  });
});

describe('ClickUp chat history', () => {
  it('lists my messages in the range with local times, overtime flags and a per-day summary', async () => {
    const calls: string[] = [];
    const r = await fakeClient(calls).history({ from: '2026-10-05', to: '2026-10-11' });
    expect(r.time_zone).toBe('Asia/Jakarta');
    expect(r.messages.map((m) => [m.id, m.date, m.time, m.overtime])).toEqual([
      ['m1', '2026-10-08', '10:00', false], ['m3', '2026-10-08', '20:30', true], ['d1m', '2026-10-09', '23:00', true], ['m4', '2026-10-10', '10:00', true],
    ]);
    expect(r.messages[0]).toMatchObject({ workspace: 'GEM', channel: 'dev-team', author: 'luz', weekday: 'Thu' });
    // every workspace by default; a DM is named after who it is with
    expect(r.workspaces).toEqual(['GEM', 'Side']);
    expect(r.messages[2]).toMatchObject({ workspace: 'Side', channel: 'DM with Budi', channel_id: 'd1' });
    expect(r.days).toEqual([
      { date: '2026-10-08', weekday: 'Thu', messages: 2, overtime_messages: 1, first: '10:00', last: '20:30' },
      { date: '2026-10-09', weekday: 'Fri', messages: 1, overtime_messages: 1, first: '23:00', last: '23:00' },
      { date: '2026-10-10', weekday: 'Sat', messages: 1, overtime_messages: 1, first: '10:00', last: '10:00' },
    ]);
    // stops paging once it reaches messages older than the range; no replies unless asked
    expect(calls.some((c) => c.includes('replies'))).toBe(false);
    expect(calls.find((c) => c.includes('/chat/channels?'))).toContain(`with_message_since=${startOfDay('2026-10-05', 'Asia/Jakarta')}`);
  });

  it('filters to overtime, includes replies and other people on request', async () => {
    const r = await fakeClient().history({ from: '2026-10-08', to: '2026-10-08', overtimeOnly: true, includeReplies: true, mineOnly: false });
    expect(r.messages.map((m) => [m.id, m.author])).toEqual([['m3', 'luz'], ['r1', 'luz']]);
    expect(r.messages[1]).toMatchObject({ reply_to: 'm3', content: 'done, deployed', time: '22:15' });
    expect(r.days).toEqual([{ date: '2026-10-08', weekday: 'Thu', messages: 4, overtime_messages: 2, first: '10:00', last: '22:15' }]);
  });

  it('reads only the workspaces asked for, or the configured default', async () => {
    const side = await fakeClient().history({ from: '2026-10-05', to: '2026-10-11', workspaceIds: ['901'] });
    expect(side.messages.map((m) => m.id)).toEqual(['d1m']);
    const calls: string[] = [];
    const gem = await fakeClient(calls, '900').history({ from: '2026-10-05', to: '2026-10-11' });
    expect(gem.workspaces).toEqual(['GEM']);
    expect(calls.some((c) => c.includes('/901/'))).toBe(false);
    await expect(fakeClient().history({ from: '2026-10-05', to: '2026-10-11', workspaceIds: ['777'] })).rejects.toThrow('no workspace 777 (it has: 900 GEM, 901 Side)');
  });

  it('lists channels across workspaces with DMs named, asking each DM for its members only once', async () => {
    const calls: string[] = [];
    const c = fakeClient(calls);
    const list = await c.channels();
    expect(list.map((x) => [x.workspace, x.name, x.type])).toEqual([['GEM', 'dev-team', 'CHANNEL'], ['GEM', 'DM with sari', 'DM'], ['Side', 'DM with Budi', 'DM']]);
    await c.channels();
    expect(calls.filter((x) => x.includes('/members')).length).toBe(2);
  });

  it('takes other work hours, channel filters and a limit', async () => {
    const r = await fakeClient().history({ from: '2026-10-08', to: '2026-10-08', workHours: '08:00-21:00', channelIds: ['c1', 'nope'], limit: 1 });
    expect(r.messages.map((m) => [m.id, m.overtime])).toEqual([['m3', false]]);
    expect(r.warnings).toEqual([
      'channel nope not found or has no messages in the range',
      '2 messages matched; only the last 1 are listed (raise limit or narrow the range)',
    ]);
  });

  it('refuses bad ranges', async () => {
    const c = fakeClient();
    await expect(c.history({ from: '2026-10-08', to: '2026-10-01' })).rejects.toThrow(/before/);
    await expect(c.history({ from: '2026-01-01', to: '2026-12-31' })).rejects.toThrow(/93 days/);
    await expect(c.history({ from: '8 Oct', to: '2026-10-08' })).rejects.toThrow(/dates/);
  });

  it('reports who it reads as', async () => {
    expect(await fakeClient().whoami()).toEqual({
      user: { id: '11', username: 'luz', email: 'luz@example.com' }, workspaces: [{ id: '900', name: 'GEM' }, { id: '901', name: 'Side' }],
      default_workspace: 'all', time_zone: 'Asia/Jakarta', work_hours: '09:00-18:00',
    });
  });
});
