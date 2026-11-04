import { ClickUp } from '../src/clickup.js';

export const wib = (iso: string) => Date.parse(`${iso}+07:00`);
const ME = '11';

/** A fake ClickUp API. Acme: a channel with two pages of messages and a thread, an empty DM. Side: a DM with one late message. */
export function fakeClickUp(calls: string[] = []): typeof fetch {
  const msg = (id: string, at: string, user: string, content: string, replies = 0) =>
    ({ id, date: wib(at), user_id: user, content, replies_count: replies, type: 'message' });
  const routes: Record<string, unknown> = {
    '/api/v2/user': { user: { id: 11, username: 'luz', email: 'luz@example.com', timezone: 'Asia/Jakarta' } },
    '/api/v2/team': { teams: [
      { id: 900, name: 'Acme', members: [{ user: { id: 11, username: 'luz' } }, { user: { id: 22, username: 'sari' } }] },
      { id: 901, name: 'Side', members: [{ user: { id: 11, username: 'luz' } }, { user: { id: 33, username: 'budi' } }] },
    ] },
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
    '/api/v3/workspaces/900/chat/channels/c2/members': { data: [{ id: '11', email: 'luz@example.com', username: 'luz' }, { id: '22', email: 'sari@example.com', username: 'sari' }], next_cursor: '' },
    '/api/v3/workspaces/901/chat/channels': { data: [{ id: 'd1', name: '', type: 'DM' }], next_cursor: '' },
    '/api/v3/workspaces/901/chat/channels/d1/members': { data: [{ id: '11', email: 'luz@example.com' }, { id: '33', email: 'budi@example.com', name: 'Budi' }], next_cursor: '' },
    '/api/v3/workspaces/901/chat/channels/d1/messages': { data: [msg('d1m', '2026-10-09T23:00:00', ME, 'fixing the client site')], next_cursor: '' },
    '/api/v3/workspaces/900/chat/messages/m3/replies': { data: [msg('r1', '2026-10-08T22:15:00', ME, 'done, deployed')], next_cursor: '' },
    '/api/v3/workspaces/900/chat/channels/c1': { data: { id: 'c1', name: 'dev-team', type: 'CHANNEL' } },
    '/api/v3/workspaces/901/chat/channels/d1': { data: { id: 'd1', name: '', type: 'DM' } },
    '/api/v2/task/t1': { id: 't1', name: 'Rekap transaksi', url: 'https://app.clickup.com/t/t1' },
  };
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if ((init?.headers as Record<string, string>).authorization !== 'pk_test') return new Response('{"err":"Token invalid","ECODE":"OAUTH_025"}', { status: 401 });
    // A sent message: "POST <path> <body>"; it gets id `new1`, sent at 2026-10-22 09:30 WIB. A DM with sari opens as c2.
    if (init?.method === 'POST') {
      calls.push(`POST ${url.pathname} ${init.body}`);
      if (url.pathname === '/api/v3/workspaces/900/chat/channels/direct_message') return new Response(JSON.stringify({ data: { id: 'c2', type: 'DM' } }), { status: 201 });
      // An upload to task t1: "UPLOAD <path> <name> <bytes>"; it is kept as att-<name>.
      if (url.pathname === '/api/v2/task/t1/attachment') {
        calls.pop();
        const f = (init.body as FormData).get('attachment') as File;
        calls.push(`UPLOAD ${url.pathname} ${f.name} ${f.size}`);
        // A file named bad-<status>.* is answered with that status.
        const failing = /^bad-(\d{3})\./.exec(f.name);
        if (failing) return new Response('{"err":"upload failed"}', { status: Number(failing[1]) });
        return new Response(JSON.stringify({ id: `att-${f.name}`, title: f.name, url: `https://files.example/${f.name}` }), { status: 200 });
      }
      return /\/(messages|replies)$/.test(url.pathname)
        ? new Response(JSON.stringify({ id: 'new1', date: wib('2026-10-22T09:30:00'), type: 'message' }), { status: 201 })
        : new Response('{"err":"nope"}', { status: 404 });
    }
    calls.push(url.pathname + url.search);
    // Custom task id DEV-42 of workspace 900 is task t1, found only with both query parameters.
    if (url.pathname === '/api/v2/task/DEV-42') {
      return url.searchParams.get('custom_task_ids') === 'true' && url.searchParams.get('team_id') === '900'
        ? new Response(JSON.stringify(routes['/api/v2/task/t1']), { status: 200 }) : new Response('{"err":"Task not found"}', { status: 404 });
    }
    const cursor = url.searchParams.get('cursor');
    if (cursor === 'p3') throw new Error('read past the start of the range');
    const body = routes[url.pathname + (cursor ? `?${cursor}` : '')];
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response('{"err":"nope"}', { status: 404 });
  }) as typeof fetch;
}

export const fakeClient = (calls?: string[], workspaceId?: string) =>
  new ClickUp({ token: 'pk_test', workspaceId, fetch: fakeClickUp(calls) });
