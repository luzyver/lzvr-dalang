import { ClickUp } from '../src/clickup.js';

export const wib = (iso: string) => Date.parse(`${iso}+07:00`);
const ME = '11';

/** A fake ClickUp API: one channel with two pages of messages and a thread, one empty DM. */
export function fakeClickUp(calls: string[] = []): typeof fetch {
  const msg = (id: string, at: string, user: string, content: string, replies = 0) =>
    ({ id, date: wib(at), user_id: user, content, replies_count: replies, type: 'message' });
  const routes: Record<string, unknown> = {
    '/api/v2/user': { user: { id: 11, username: 'luz', email: 'luz@example.com', timezone: 'Asia/Jakarta' } },
    '/api/v2/team': { teams: [{ id: 900, name: 'GEM', members: [{ user: { id: 11, username: 'luz' } }, { user: { id: 22, username: 'sari' } }] }] },
    '/api/v3/workspaces/900/chat/channels': { data: [{ id: 'c1', name: 'dev-team', type: 'CHANNEL' }, { id: 'c2', name: '', type: 'DM' }], next_cursor: '' },
    '/api/v3/workspaces/900/chat/channels/c1/messages': { data: [
      msg('m4', '2026-10-10T10:00:00', ME, 'patch prod on saturday'),
      msg('m3', '2026-10-08T20:30:00', ME, 'still fixing the invoice export', 1),
    ], next_cursor: 'p2' },
    '/api/v3/workspaces/900/chat/channels/c1/messages?p2': { data: [
      msg('m2', '2026-10-08T14:00:00', '22', 'can you check invoices?'),
      msg('m1', '2026-10-08T10:00:00', ME, 'morning'),
      msg('m0', '2026-09-01T10:00:00', ME, 'way too old'),
    ], next_cursor: 'p3' },
    '/api/v3/workspaces/900/chat/channels/c2/messages': { data: [], next_cursor: '' },
    '/api/v3/workspaces/900/chat/messages/m3/replies': { data: [msg('r1', '2026-10-08T22:15:00', ME, 'done, deployed')], next_cursor: '' },
  };
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if ((init?.headers as Record<string, string>).authorization !== 'pk_test') return new Response('{"err":"Token invalid","ECODE":"OAUTH_025"}', { status: 401 });
    calls.push(url.pathname + url.search);
    const cursor = url.searchParams.get('cursor');
    if (cursor === 'p3') throw new Error('read past the start of the range');
    const body = routes[url.pathname + (cursor ? `?${cursor}` : '')];
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response('{"err":"nope"}', { status: 404 });
  }) as typeof fetch;
}

export const fakeClient = (calls?: string[]) => new ClickUp({ token: 'pk_test', workHours: '09:00-18:00', fetch: fakeClickUp(calls) });
