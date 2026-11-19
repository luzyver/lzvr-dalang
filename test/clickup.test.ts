import { describe, expect, it } from 'vitest';
import { ClickUp, ClickUpError, ClickUpUncertain, localParts, startOfDay } from '../src/clickup.js';
import { changes, fakeClickUp, fakeClient, wib } from './fake-clickup.js';

const of = (calls: string[], tool: string) => calls.filter((c) => c.startsWith(`${tool} `));

describe('time helpers', () => {
  it('finds local midnight and wall-clock time in a zone', () => {
    expect(startOfDay('2026-10-08', 'Asia/Jakarta')).toBe(Date.parse('2026-10-07T17:00:00Z'));
    expect(startOfDay('2026-03-29', 'Europe/Amsterdam')).toBe(Date.parse('2026-03-28T23:00:00Z')); // DST starts that day
    expect(localParts(wib('2026-10-08T20:30:00'), 'Asia/Jakarta')).toMatchObject({ date: '2026-10-08', time: '20:30', weekday: 'Thu' });
  });
});

describe('ClickUp connection', () => {
  it('calls a tool of ClickUp\'s MCP server in the workspace asked for, else the configured one', async () => {
    const calls: string[] = [];
    await fakeClient(calls).call('clickup_get_list', { list_id: 'l1' });
    await fakeClient(calls, '900').call('clickup_get_list', { list_id: 'l1' });
    await fakeClient(calls, '900').call('clickup_get_workspace_members', {}, '901');
    expect(calls).toEqual([
      'clickup_get_list {"list_id":"l1"}', 'clickup_get_list {"list_id":"l1","workspace_id":"900"}', 'clickup_get_workspace_members {"workspace_id":"901"}',
    ]);
  });

  it('tells a refusal, which did nothing, from a failure that does not say', async () => {
    const c = fakeClient();
    const gone = await c.call('clickup_get_list', { list_id: 'nope' }).catch((e) => e);
    expect(gone).toBeInstanceOf(ClickUpError);
    expect(gone).not.toBeInstanceOf(ClickUpUncertain);
    expect(gone.message).toMatch(/List not found/);
    expect(await c.call('clickup_send_chat_message', { channel_id: 'c1', content: 'boom' }).catch((e) => e)).toBeInstanceOf(ClickUpUncertain);
    expect(await c.call('clickup_no_such_tool').catch((e) => e)).not.toBeInstanceOf(ClickUpUncertain);
    const old = await fakeClient([], undefined, 'old').call('clickup_get_user').catch((e) => e);
    expect(old).toMatchObject({ status: 401 });
    expect(old.message).toMatch(/connect ClickUp again/);
    const budget = { left: 1 };
    await c.call('clickup_get_user', {}, undefined, budget);
    await expect(c.call('clickup_get_user', {}, undefined, budget)).rejects.toThrow(/budget/);
  });

  it('reports who it reads as, and in which workspace', async () => {
    expect(await fakeClient().whoami()).toEqual({
      user: { id: '11', username: 'luz', email: 'luz@example.com' }, workspaces: [{ id: '900', name: 'Acme' }], default_workspace: '900', time_zone: 'Asia/Jakarta',
    });
    expect(await fakeClient([], '901').whoami()).toMatchObject({ workspaces: [{ id: '901', name: 'Side' }], default_workspace: '901' });
    await expect(fakeClient([], '777').whoami()).rejects.toThrow(/workspace 777 is not in this ClickUp connection/);
  });
});

describe('ClickUp chat history', () => {
  it('lists my messages in the range with local dates and times', async () => {
    const calls: string[] = [];
    const r = await fakeClient(calls).history({ from: '2026-10-05', to: '2026-10-11' });
    expect(r.time_zone).toBe('Asia/Jakarta');
    expect(r.messages.map((m) => [m.id, m.date, m.time])).toEqual([['m1', '2026-10-08', '10:00'], ['m3', '2026-10-08', '20:30'], ['m4', '2026-10-10', '10:00']]);
    expect(r.messages[0]).toMatchObject({ workspace: 'Acme', channel: 'dev-team', author: 'luz', weekday: 'Thu' });
    expect(r.workspaces).toEqual(['Acme']);
    // stops paging once it reaches messages older than the range (the fake throws past them); no replies unless asked;
    // a channel made after the range is not read
    expect(of(calls, 'clickup_get_chat_message_replies')).toEqual([]);
    expect(calls.some((c) => c.includes('"channel_id":"c9"'))).toBe(false);
    // nor one ClickUp says was last written in before the range, unless replies are asked for (a reply may be newer)
    expect(calls.some((c) => c.includes('"channel_id":"c2"'))).toBe(false);
    expect(r.channels_read).toBe(1);
    await fakeClient(calls).history({ from: '2026-10-05', to: '2026-10-11', includeReplies: true });
    expect(calls.some((c) => c.includes('"channel_id":"c2"'))).toBe(true);
  });

  it('reads the channels last written in first when there are more than one call may read, and names the ones left', async () => {
    const calls: string[] = [];
    const r = await fakeClient(calls, '902').history({ from: '2026-10-05', to: '2026-10-11' });
    const asked = of(calls, 'clickup_get_chat_channel_messages').map((c) => Number(/"channel_id":"b(\d+)"/.exec(c)![1]));
    expect(asked.length).toBeLessThan(300);
    expect(Math.max(...asked)).toBe(asked.length - 1); // the newest ones, none skipped among them
    expect(r.messages).toHaveLength(asked.length);
    expect(r.channels_read).toBe(asked.length);
    expect(r.warnings?.join()).toMatch(new RegExp(`stopped early.* ${300 - asked.length} of 300 channels were not read.*big-${asked.length}, .*…\\. Narrow the range or pick channels`));
  });

  it('includes replies and other people on request', async () => {
    const r = await fakeClient().history({ from: '2026-10-08', to: '2026-10-08', includeReplies: true, mineOnly: false });
    expect(r.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'r1']);
    expect(r.messages.find((m) => m.id === 'r1')).toMatchObject({ reply_to: 'm3', content: 'done, deployed', time: '22:15', author: 'luz' });
    expect(r.messages[1]).toMatchObject({ author: 'sari' });
  });

  it('reads the workspaces asked for, or the configured default', async () => {
    const both = await fakeClient().history({ from: '2026-10-05', to: '2026-10-11', workspaceIds: ['900', '901'] });
    expect(both.workspaces).toEqual(['Acme', 'Side']);
    expect(both.messages.map((m) => m.id)).toEqual(['m1', 'm3', 'd1m', 'm4']);
    expect(both.messages[2]).toMatchObject({ workspace: 'Side', channel: 'DM with budi', channel_id: 'd1' }); // named after who wrote in it
    const side = await fakeClient([], '901').history({ from: '2026-10-05', to: '2026-10-11' });
    expect(side.messages.map((m) => m.id)).toEqual(['d1m']);
    await expect(fakeClient().history({ from: '2026-10-05', to: '2026-10-11', workspaceIds: ['777'] })).rejects.toThrow(/workspace 777 is not in this ClickUp connection/);
  });

  it('lists channels with DMs named after who wrote in them, reading each DM only once', async () => {
    const calls: string[] = [];
    const c = fakeClient(calls);
    const list = await c.channels();
    expect(list.map((x) => [x.workspace, x.name, x.type])).toEqual([['Acme', 'dev-team', 'CHANNEL'], ['Acme', 'DM with sari', 'DM'], ['Acme', 'later', 'CHANNEL']]);
    expect((await c.channels()).map((x) => x.name)).toContain('DM with sari');
    expect(of(calls, 'clickup_get_chat_channel_messages')).toHaveLength(1);
  });

  it('takes channel filters and a limit', async () => {
    const r = await fakeClient().history({ from: '2026-10-08', to: '2026-10-08', channelIds: ['c1', 'nope'], limit: 1 });
    expect(r.messages.map((m) => m.id)).toEqual(['m3']);
    expect(r.warnings).toEqual(['channel nope not found', '2 messages matched; only the last 1 are listed (raise limit or narrow the range)']);
  });

  it('refuses bad ranges', async () => {
    const c = fakeClient();
    await expect(c.history({ from: '2026-10-08', to: '2026-10-01' })).rejects.toThrow(/before/);
    await expect(c.history({ from: '2026-01-01', to: '2026-12-31' })).rejects.toThrow(/93 days/);
    await expect(c.history({ from: '8 Oct', to: '2026-10-08' })).rejects.toThrow(/dates/);
  });
});

describe('ClickUp send', () => {
  it('sends to a channel, as markdown', async () => {
    const calls: string[] = [];
    const r = await fakeClient(calls).send({ channelId: 'c1', content: '  **done**, deployed  ' });
    expect(r).toMatchObject({ sent: true, id: 'new1', workspace: 'Acme', channel: 'dev-team', channel_id: 'c1' });
    expect(changes(calls)).toEqual(['clickup_send_chat_message {"channel_id":"c1","content":"**done**, deployed","content_format":"text/md","workspace_id":"900"}']);
  });

  it('replies in a thread, and sends in another workspace when named', async () => {
    const calls: string[] = [];
    const c = fakeClient(calls);
    expect(await c.send({ channelId: 'c1', content: 'on it', replyTo: 'm3' })).toMatchObject({ sent: true, channel: 'dev-team', reply_to: 'm3' });
    expect(await c.send({ channelId: 'd1', content: 'ok', workspaceId: '901' })).toMatchObject({ sent: true, workspace: 'Side', channel: 'DM with budi' });
    expect(changes(calls)).toEqual([
      'clickup_send_chat_message {"parent_message_id":"m3","content":"on it","content_format":"text/md","workspace_id":"900"}',
      'clickup_send_chat_message {"channel_id":"d1","content":"ok","content_format":"text/md","workspace_id":"901"}',
    ]);
  });

  it('refuses an unknown channel or an empty or too long message, sending nothing', async () => {
    const calls: string[] = [];
    const c = fakeClient(calls);
    await expect(c.send({ channelId: 'nope', content: 'hi' })).rejects.toThrow(/channel nope not found/);
    await expect(c.send({ channelId: 'd1', content: 'hi' })).rejects.toThrow(/not found/); // of another workspace
    await expect(c.send({ channelId: 'c1', content: '   ' })).rejects.toThrow(/empty/);
    await expect(c.send({ channelId: 'c1', content: 'x'.repeat(4001) })).rejects.toThrow(/4000/);
    expect(changes(calls)).toEqual([]);
  });

  it('messages a person privately', async () => {
    const calls: string[] = [];
    const c = fakeClient(calls);
    expect(await c.send({ toUserId: '22', content: 'hi' })).toMatchObject({ sent: true, channel: 'DM with sari', channel_id: 'c2', workspace: 'Acme' });
    expect(changes(calls)).toEqual(['clickup_send_chat_message {"user_ids":["22"],"content":"hi","content_format":"text/md","workspace_id":"900"}']);
    await expect(c.send({ toUserId: '11', content: 'hi' })).rejects.toThrow(/no person 11/); // not oneself
    await expect(c.send({ toUserId: '22', channelId: 'c1', content: 'hi' })).rejects.toThrow(/either/);
    await expect(c.send({ toUserId: '22', replyTo: 'm3', content: 'hi' })).rejects.toThrow(/reply_to needs channel_id/);
    expect(changes(calls)).toHaveLength(1);
  });

  it('names the destination and the thread replied to before anything is sent', async () => {
    const calls: string[] = [];
    const c = fakeClient(calls);
    expect(await c.destination({ channelId: 'c1', replyTo: 'm3' })).toEqual({
      workspace_id: '900', workspace: 'Acme', channel_id: 'c1', channel: 'dev-team', reply_to: 'm3',
      thread: { author: 'luz', date: '2026-10-08', time: '20:30', weekday: 'Thu', preview: 'still fixing the invoice export' },
    });
    // A reply names no channel: a message of another channel must not pass for a thread of this one.
    await expect(c.destination({ channelId: 'd1', replyTo: 'm3', workspaceId: '901' })).rejects.toThrow(/m3 is not among the latest 500/);
    await expect(c.destination({ channelId: 'c1', replyTo: 'old' })).rejects.toThrow(); // looked for, or could not be: refused either way
    expect(changes(calls)).toEqual([]);
    // A DM picked by id, without listing channels first, still says who it is with.
    expect(await fakeClient().destination({ channelId: 'c2' })).toMatchObject({ channel_id: 'c2', channel: 'DM with sari' });
  });

  it('lists threads to pick and people to message', async () => {
    const c = fakeClient();
    expect((await c.threads('c1')).messages.map((m) => [m.id, m.author, m.has_replies])).toEqual([['m4', 'luz', false], ['m3', 'luz', true]]);
    expect(await c.people('SAR')).toEqual([{ id: '22', name: 'sari', email: 'sari@example.com', workspace_id: '900', workspace: 'Acme' }]);
    expect((await c.people(undefined, ['900', '901'])).map((p) => p.name)).toEqual(['sari', 'budi']);
  });

  it('reads everything it needs before sending, so a failure never leaves a sent message behind', async () => {
    const calls: string[] = [];
    const inner = fakeClickUp(calls);
    // the ClickUp user (time zone) cannot be read just now
    const flaky = (async (input: string | URL, init?: RequestInit) => (String(init?.body).includes('"clickup_get_user"')
      ? new Response('{"error":"busy"}', { status: 503 }) : inner(input, init))) as typeof fetch;
    const c = new ClickUp({ token: 'mcp_test', fetch: flaky });
    await expect(c.send({ channelId: 'c1', content: 'hi' })).rejects.toThrow(/503/);
    expect(changes(calls)).toEqual([]);
  });
});

describe('ClickUp files', () => {
  const file = (name: string) => ({ name, data: Buffer.from(name) });

  it('finds a task by id, by link and by custom id, in the workspace of its link', async () => {
    const calls: string[] = [];
    const c = fakeClient(calls);
    const t1 = { id: 't1', name: 'Rekap transaksi', url: 'https://app.clickup.com/t/t1' };
    expect(await c.task('t1')).toEqual(t1);
    expect(await c.task('https://app.clickup.com/t/t1')).toEqual(t1);
    expect(await c.task('https://app.clickup.com/t/900/DEV-42')).toEqual({ ...t1, workspace_id: '900' }); // uploads then go to t1, its own id
    expect(calls).toContain('clickup_get_task {"task_id":"DEV-42","workspace_id":"900"}');
    expect(await c.task('DEV-42')).toEqual(t1);
    await expect(c.task('DEV-99')).rejects.toThrow(/no task DEV-99/);
    await expect(c.task('not a task')).rejects.toThrow(/not a task id or link/);
  });

  it('puts files into the message itself: each uploaded for the channel or thread, then named by the message', async () => {
    const calls: string[] = [];
    const c = fakeClient(calls);
    const dest = await c.destination({ channelId: 'c1' });
    expect(await c.deliver(dest, 'rekap', [file('a.xlsx'), file('shot [1].png')])).toMatchObject({ sent: true, id: 'new1', channel_id: 'c1', attached: 2 });
    expect(changes(calls)).toEqual([
      'UPLOAD c1 a.xlsx 6',
      'UPLOAD c1 shot [1].png 12',
      `clickup_send_chat_message ${JSON.stringify({ channel_id: 'c1', content: 'rekap\n\n[a.xlsx](#attachment#f-a.xlsx)\n![shot 1.png](#attachment#f-shot [1].png)', content_format: 'text/md', workspace_id: '900' })}`,
    ]);

    // a reply in a thread; a person gets the text first, which opens the DM the files then go to
    calls.length = 0;
    await c.deliver(await c.destination({ channelId: 'c1', replyTo: 'm3' }), 'hi', [file('a.xlsx')]);
    expect(await c.deliver(await c.destination({ toUserId: '22' }), 'hi', [file('a.xlsx')])).toMatchObject({ sent: true, channel_id: 'c2', attached: 1 });
    expect(changes(calls).map((l) => l.replace(/,"content_format".*/, ''))).toEqual([
      'UPLOAD reply:m3 a.xlsx 6', 'clickup_send_chat_message {"parent_message_id":"m3","content":"hi\\n\\n[a.xlsx](#attachment#f-a.xlsx)"',
      'clickup_send_chat_message {"user_ids":["22"],"content":"hi"', 'UPLOAD c2 a.xlsx 6', 'clickup_send_chat_message {"channel_id":"c2","content":"[a.xlsx](#attachment#f-a.xlsx)"',
    ]);
  });

  it('calls an upload refused failed, sending nothing, and a send that fails uncertain', async () => {
    const calls: string[] = [];
    const c = fakeClient(calls);
    const dest = await c.destination({ channelId: 'c1' });
    const refused = await c.deliver(dest, 'hi', [file('bad-400.xlsx')]).catch((e) => e);
    expect(refused).toBeInstanceOf(ClickUpError);
    expect(refused).not.toBeInstanceOf(ClickUpUncertain);
    expect(of(calls, 'clickup_send_chat_message')).toEqual([]);
    expect(await c.deliver(dest, 'boom', [file('a.xlsx')]).catch((e) => e)).toBeInstanceOf(ClickUpUncertain);
    expect(await c.deliver(dest, 'refuse this').catch((e) => e)).not.toBeInstanceOf(ClickUpUncertain);
    // the text reached the person, the file did not: nobody should send the text again
    const late = await c.deliver(await c.destination({ toUserId: '22' }), 'hi', [file('bad-400.xlsx')]).catch((e) => e);
    expect(late).toBeInstanceOf(ClickUpUncertain);
    expect(late.message).toMatch(/the message was sent to DM with sari, but its file was not/);
    const gone = await fakeClient(calls, undefined, 'old').deliver(dest, 'hi', [file('a.xlsx')]).catch((e) => e);
    expect(gone).not.toBeInstanceOf(ClickUpUncertain);
    expect(gone.message).toMatch(/connect ClickUp again/);
  });

  it('attaches files to a task, and calls a failure once one may be there uncertain, naming those already uploaded', async () => {
    const calls: string[] = [];
    const c = fakeClient(calls);
    const task = await c.task('t1');
    expect(await c.attach(task, [file('a.xlsx')])).toEqual([{ name: 'a.xlsx', url: 'https://files.example/a.xlsx' }]);
    const first = await c.attach(task, [file('bad-400.xlsx')]).catch((e) => e);
    expect(first).toBeInstanceOf(ClickUpError);
    expect(first).not.toBeInstanceOf(ClickUpUncertain);
    // the second upload is refused after the first went through
    const partial = await c.attach(task, [file('a.xlsx'), file('bad-400.xlsx')]).catch((e) => e);
    expect(partial).toBeInstanceOf(ClickUpUncertain);
    expect(partial.message).toMatch(/Already on task "Rekap transaksi".*a\.xlsx\]\(https:\/\/files\.example\/a\.xlsx\)/);
    // a 5xx says nothing about whether ClickUp kept it
    const lost = await c.attach(task, [file('bad-502.xlsx')]).catch((e) => e);
    expect(lost).toBeInstanceOf(ClickUpUncertain);
    expect(lost.message).toMatch(/Check the task before sending them again/);
    expect(calls.filter((x) => x.startsWith('UPLOAD ')).map((x) => x.split(' ')[2])).toEqual(['a.xlsx', 'bad-400.xlsx', 'a.xlsx', 'bad-400.xlsx', 'bad-502.xlsx']);
  });
});
