import { describe, expect, it } from 'vitest';
import { localParts, startOfDay } from '../src/clickup.js';
import { fakeClient, wib } from './fake-clickup.js';

describe('time helpers', () => {
  it('finds local midnight and wall-clock time in a zone', () => {
    expect(startOfDay('2026-10-08', 'Asia/Jakarta')).toBe(Date.parse('2026-10-07T17:00:00Z'));
    expect(startOfDay('2026-03-29', 'Europe/Amsterdam')).toBe(Date.parse('2026-03-28T23:00:00Z')); // DST starts that day
    expect(localParts(wib('2026-10-08T20:30:00'), 'Asia/Jakarta')).toMatchObject({ date: '2026-10-08', time: '20:30', weekday: 'Thu' });
  });
});

describe('ClickUp chat history', () => {
  it('lists my messages in the range with local dates and times', async () => {
    const calls: string[] = [];
    const r = await fakeClient(calls).history({ from: '2026-10-05', to: '2026-10-11' });
    expect(r.time_zone).toBe('Asia/Jakarta');
    expect(r.messages.map((m) => [m.id, m.date, m.time])).toEqual([
      ['m1', '2026-10-08', '10:00'], ['m3', '2026-10-08', '20:30'], ['d1m', '2026-10-09', '23:00'], ['m4', '2026-10-10', '10:00'],
    ]);
    expect(r.messages[0]).toMatchObject({ workspace: 'Acme', channel: 'dev-team', author: 'luz', weekday: 'Thu' });
    // every workspace by default; a DM is named after who it is with
    expect(r.workspaces).toEqual(['Acme', 'Side']);
    expect(r.messages[2]).toMatchObject({ workspace: 'Side', channel: 'DM with Budi', channel_id: 'd1' });
    // stops paging once it reaches messages older than the range; no replies unless asked
    expect(calls.some((c) => c.includes('replies'))).toBe(false);
    expect(calls.find((c) => c.includes('/chat/channels?'))).toContain(`with_message_since=${startOfDay('2026-10-05', 'Asia/Jakarta')}`);
  });

  it('includes replies and other people on request', async () => {
    const r = await fakeClient().history({ from: '2026-10-08', to: '2026-10-08', includeReplies: true, mineOnly: false });
    expect(r.messages).toHaveLength(4);
    expect(r.messages.find((m) => m.id === 'r1')).toMatchObject({ reply_to: 'm3', content: 'done, deployed', time: '22:15', author: 'luz' });
  });

  it('reads only the workspaces asked for, or the configured default', async () => {
    const side = await fakeClient().history({ from: '2026-10-05', to: '2026-10-11', workspaceIds: ['901'] });
    expect(side.messages.map((m) => m.id)).toEqual(['d1m']);
    const calls: string[] = [];
    const one = await fakeClient(calls, '900').history({ from: '2026-10-05', to: '2026-10-11' });
    expect(one.workspaces).toEqual(['Acme']);
    expect(calls.some((c) => c.includes('/901/'))).toBe(false);
    await expect(fakeClient().history({ from: '2026-10-05', to: '2026-10-11', workspaceIds: ['777'] })).rejects.toThrow('no workspace 777 (it has: 900 Acme, 901 Side)');
  });

  it('lists channels across workspaces with DMs named, asking each DM for its members only once', async () => {
    const calls: string[] = [];
    const c = fakeClient(calls);
    const list = await c.channels();
    expect(list.map((x) => [x.workspace, x.name, x.type])).toEqual([['Acme', 'dev-team', 'CHANNEL'], ['Acme', 'DM with sari', 'DM'], ['Side', 'DM with Budi', 'DM']]);
    await c.channels();
    expect(calls.filter((x) => x.includes('/members')).length).toBe(2);
  });

  it('takes channel filters and a limit', async () => {
    const r = await fakeClient().history({ from: '2026-10-08', to: '2026-10-08', channelIds: ['c1', 'nope'], limit: 1 });
    expect(r.messages.map((m) => m.id)).toEqual(['m3']);
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
      user: { id: '11', username: 'luz', email: 'luz@example.com' }, workspaces: [{ id: '900', name: 'Acme' }, { id: '901', name: 'Side' }],
      default_workspace: 'all', time_zone: 'Asia/Jakarta',
    });
  });
});

describe('ClickUp send', () => {
  const posts = (calls: string[]) => calls.filter((c) => c.startsWith('POST '));

  it('sends to a channel found in any workspace, as markdown', async () => {
    const calls: string[] = [];
    const r = await fakeClient(calls).send({ channelId: 'd1', content: '  **done**, deployed  ' });
    expect(r).toEqual({ sent: true, id: 'new1', workspace: 'Side', channel: 'Direct message', channel_id: 'd1', date: '2026-10-22', time: '09:30' });
    expect(posts(calls)).toEqual(['POST /api/v3/workspaces/901/chat/channels/d1/messages {"type":"message","content":"**done**, deployed","content_format":"text/md"}']);
  });

  it('replies in a thread', async () => {
    const calls: string[] = [];
    const r = await fakeClient(calls).send({ channelId: 'c1', content: 'on it', replyTo: 'm3', workspaceId: '900' });
    expect(r).toMatchObject({ sent: true, channel: 'dev-team', reply_to: 'm3' });
    expect(posts(calls)).toEqual(['POST /api/v3/workspaces/900/chat/messages/m3/replies {"type":"message","content":"on it","content_format":"text/md"}']);
    expect(calls).not.toContain('/api/v3/workspaces/901/chat/channels/c1'); // the named workspace only
  });

  it('refuses an unknown channel or an empty or too long message, sending nothing', async () => {
    const calls: string[] = [];
    const c = fakeClient(calls);
    await expect(c.send({ channelId: 'nope', content: 'hi' })).rejects.toThrow(/channel nope not found/);
    await expect(c.send({ channelId: 'd1', content: 'hi', workspaceId: '900' })).rejects.toThrow(/not found/);
    await expect(c.send({ channelId: 'c1', content: '   ' })).rejects.toThrow(/empty/);
    await expect(c.send({ channelId: 'c1', content: 'x'.repeat(4001) })).rejects.toThrow(/4000/);
    expect(posts(calls)).toEqual([]);
  });
});
