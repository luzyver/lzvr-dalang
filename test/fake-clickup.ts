import { ClickUp } from '../src/clickup.js';

export const wib = (iso: string) => Date.parse(`${iso}+07:00`);
const ME = '11';

/**
 * A fake ClickUp API. Acme: a channel with two pages of messages and a thread, an empty DM; a space with a list of two
 * tasks (t1 with a checklist, a custom field, a comment), two time entries and a Doc of two pages. Side: a DM with one
 * late message.
 */
export function fakeClickUp(calls: string[] = []): typeof fetch {
  const msg = (id: string, at: string, user: string, content: string, replies = 0) =>
    ({ id, date: wib(at), user_id: user, content, replies_count: replies, type: 'message' });
  const module = { id: 'cf1', name: 'Module', type: 'drop_down', type_config: { options: [{ id: 'o1', name: 'Billing', orderindex: 0 }, { id: 'o2', name: 'Auth', orderindex: 1 }] } };
  const t1 = {
    id: 't1', custom_id: 'DEV-42', name: 'Rekap transaksi', url: 'https://app.clickup.com/t/t1', team_id: '900', status: { id: 'st2', status: 'in progress' },
    assignees: [{ id: 11, username: 'luz' }], due_date: String(wib('2026-10-12T04:00:00')), due_date_time: false, priority: { priority: 'high' },
    list: { id: 'l1', name: 'Backlog' }, space: { id: 's1' }, markdown_description: 'Rekap **bulanan**', tags: [{ name: 'finance' }],
    date_created: String(wib('2026-10-01T08:00:00')), date_updated: String(wib('2026-10-09T09:00:00')), time_estimate: 7200000,
    checklists: [{ id: 'ck1', name: 'QA', items: [{ id: 'i1', name: 'cek total', resolved: false }] }],
    custom_fields: [{ ...module, value: 0 }, { id: 'cf2', name: 'Notes', type: 'text' }],
    dependencies: [{ task_id: 't1', depends_on: 't2' }],
  };
  const t2 = { id: 't2', name: 'Fix login', url: 'https://app.clickup.com/t/t2', team_id: '900', status: { status: 'to do' }, assignees: [], list: { id: 'l1', name: 'Backlog' } };
  const t3 = { id: 't3', name: 'Client site', url: 'https://app.clickup.com/t/t3', team_id: '901', status: { status: 'open' }, assignees: [], date_updated: String(wib('2026-10-10T09:00:00')) };
  // Task t2 has 27 comments, k27 the newest: ClickUp gives 25 at a time, older ones after `start` and `start_id`.
  const many = Array.from({ length: 27 }, (_, i) => ({ id: `k${27 - i}`, comment_text: `note ${27 - i}`, user: { id: 11, username: 'luz' }, date: String(wib('2026-10-09T10:00:00') - i * 60_000) }));
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
    '/api/v2/task/t1': t1,
    '/api/v2/task/t2': t2,
    '/api/v2/task/t1/comment': { comments: [{ id: 'cm1', comment_text: 'sudah dicek', user: { id: 22, username: 'sari' }, date: String(wib('2026-10-09T09:00:00')), reply_count: 1 }] },
    '/api/v2/team/900/space': { spaces: [{ id: 's1', name: 'Engineering' }] },
    '/api/v2/team/901/space': { spaces: [] },
    '/api/v2/space/s1/folder': { folders: [{ id: 'f1', name: 'Sprints', lists: [{ id: 'l2', name: 'Sprint 12', task_count: 3 }] }] },
    '/api/v2/space/s1/list': { lists: [{ id: 'l1', name: 'Backlog', task_count: '2' }] },
    '/api/v2/list/l1': {
      id: 'l1', name: 'Backlog', space: { id: 's1', name: 'Engineering' }, folder: { id: 'h', name: 'hidden', hidden: true },
      statuses: [{ id: 'st1', status: 'to do', type: 'open' }, { id: 'st2', status: 'in progress', type: 'custom' }, { id: 'st3', status: 'done', type: 'closed' }],
    },
    '/api/v2/list/l2': { id: 'l2', name: 'Sprint 12', space: { id: 's1', name: 'Engineering' }, folder: { id: 'f1', name: 'Sprints' }, statuses: [{ id: 'sp1', status: 'to do', type: 'open' }, { id: 'sp2', status: 'review', type: 'custom' }] },
    '/api/v2/list/l1/field': { fields: [{ ...module, required: true }] },
    '/api/v2/team/900/task': { tasks: [t1, t2], last_page: true },
    '/api/v2/team/901/task': { tasks: [t3], last_page: true },
    '/api/v2/team/900/time_entries': { data: [
      { id: 'te2', user: { id: 11, username: 'luz' }, start: String(wib('2026-10-09T09:00:00')), end: String(wib('2026-10-09T10:00:00')), duration: '3600000', description: '', billable: true },
      {
        id: 'te1', task: { id: 't1', name: 'Rekap transaksi' }, user: { id: 11, username: 'luz' }, start: String(wib('2026-10-08T19:00:00')),
        end: String(wib('2026-10-08T21:30:00')), duration: '9000000', description: 'lembur rekap', billable: false, task_location: { list_name: 'Backlog' },
      },
    ] },
    '/api/v2/team/901/time_entries': { data: [] },
    '/api/v3/workspaces/900/docs': { docs: [{ id: 'doc1', name: 'Runbook', date_updated: wib('2026-10-07T10:00:00') }], next_cursor: '' },
    '/api/v3/workspaces/901/docs': { docs: [], next_cursor: '' },
    '/api/v3/workspaces/900/docs/doc1': { id: 'doc1', name: 'Runbook' },
    '/api/v3/workspaces/900/docs/doc1/pages': [{ id: 'p1', name: 'Deploy', content: '# Deploy', pages: [{ id: 'p2', name: 'Rollback', content: 'undo' }] }],
    '/api/v3/workspaces/900/docs/doc1/pages/p1': { id: 'p1', name: 'Deploy', content: '# Deploy\n\nsteps' },
  };
  // What a change answers: "<METHOD> <path>" -> body. Anything else changed is refused (404).
  const writes: Record<string, unknown> = {
    'POST /api/v2/list/l1/task': { id: 't9', url: 'https://app.clickup.com/t/t9' },
    'PUT /api/v2/task/t1': { id: 't1', url: 'https://app.clickup.com/t/t1' },
    'PUT /api/v3/workspaces/900/tasks/t1/home_list/l2': { data: { task_id: 't1', new_list_id: 'l2' } },
    'POST /api/v2/task/t1/tag/urgent%20fix': {},
    'DELETE /api/v2/task/t1/tag/finance': '',
    'POST /api/v2/task/t1/field/cf1': {},
    'POST /api/v2/task/t1/comment': { id: 'cm9' },
    'POST /api/v2/comment/cm1/reply': { id: 'cm10' },
    'POST /api/v2/task/t1/checklist': { checklist: { id: 'ck9' } },
    'POST /api/v2/checklist/ck9/checklist_item': { checklist: { id: 'ck9' } },
    'POST /api/v2/checklist/ck1/checklist_item': { checklist: { id: 'ck1' } },
    'PUT /api/v2/checklist/ck1/checklist_item/i1': { checklist: { id: 'ck1' } },
    'POST /api/v2/task/t1/dependency': {},
    'DELETE /api/v2/task/t1/link/t2': '',
    'POST /api/v2/team/900/time_entries': { data: { id: 'te9' } },
    'POST /api/v3/workspaces/900/docs': { id: 'doc9' },
    'POST /api/v3/workspaces/900/docs/doc9/pages': { id: 'p9' },
    'PUT /api/v3/workspaces/900/docs/doc1/pages/p1': {},
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
      if (/\/(messages|replies)$/.test(url.pathname)) return new Response(JSON.stringify({ id: 'new1', date: wib('2026-10-22T09:30:00'), type: 'message' }), { status: 201 });
    }
    // A change: "<METHOD> <path><query> <body>". A checklist item named boom-<status> is answered with that status.
    if (init?.method && init.method !== 'GET') {
      if (init.method !== 'POST') calls.push(`${init.method} ${url.pathname}${url.search} ${init.body ?? ''}`.trim());
      const failing = /"name":"boom-(\d{3})"/.exec(String(init.body ?? ''));
      if (failing) return new Response('{"err":"boom"}', { status: Number(failing[1]) });
      const answer = writes[`${init.method} ${url.pathname}`];
      return answer === undefined ? new Response('{"err":"nope"}', { status: 404 }) : new Response(answer === '' ? '' : JSON.stringify(answer), { status: 200 });
    }
    calls.push(url.pathname + url.search);
    // Custom task id DEV-42 of workspace 900 is task t1, found only with both query parameters.
    if (url.pathname === '/api/v2/task/DEV-42') {
      return url.searchParams.get('custom_task_ids') === 'true' && url.searchParams.get('team_id') === '900'
        ? new Response(JSON.stringify(routes['/api/v2/task/t1']), { status: 200 }) : new Response('{"err":"Task not found"}', { status: 404 });
    }
    // Custom task id DUP-1 is a task in both workspaces.
    if (url.pathname === '/api/v2/task/DUP-1') {
      const team = url.searchParams.get('custom_task_ids') === 'true' ? url.searchParams.get('team_id') : null;
      return team === '900' || team === '901' ? new Response(JSON.stringify(team === '900' ? t2 : t3), { status: 200 }) : new Response('{"err":"Task not found"}', { status: 404 });
    }
    if (url.pathname === '/api/v2/task/t2/comment') {
      const from = url.searchParams.get('start_id');
      const at = from ? many.findIndex((c) => c.id === from && c.date === url.searchParams.get('start')) + 1 : 0;
      return new Response(JSON.stringify({ comments: from && !at ? [] : many.slice(at, at + 25) }), { status: 200 });
    }
    const cursor = url.searchParams.get('cursor');
    if (cursor === 'p3') throw new Error('read past the start of the range');
    const body = routes[url.pathname + (cursor ? `?${cursor}` : '')];
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response('{"err":"nope"}', { status: 404 });
  }) as typeof fetch;
}

export const fakeClient = (calls?: string[], workspaceId?: string) =>
  new ClickUp({ token: 'pk_test', workspaceId, fetch: fakeClickUp(calls) });
