import { ClickUp } from '../src/clickup.js';

export const wib = (iso: string) => Date.parse(`${iso}+07:00`);
const ME = '11';

/**
 * A fake of ClickUp's MCP server (https://mcp.clickup.com). A client registers as `client1`, code `code1` buys access
 * token `mcp_test`, which reads as user luz. Its workspace is Acme (900): a channel with two pages of messages and a
 * thread, a DM with sari, a space with a folder and two lists, three tasks (t1 with a checklist, a custom field and a
 * comment; t2 with 27 comments), two time entries and a Doc of two pages. Workspace Side (901) is there when asked
 * for by id: a DM with budi and task t3.
 *
 * `calls` gets one line per tool call ("<tool> <arguments>"), upload ("UPLOAD <ticket> <name> <bytes>") and client
 * registration ("REGISTER <redirect uri>"). A file named bad-<status>.* is refused at the upload with that status;
 * message or comment text starting with `boom` fails the tool without saying why, `refuse` fails it as not allowed.
 */
export function fakeClickUp(calls: string[] = []): typeof fetch {
  const msg = (id: string, at: string, user: string, content: string, replies = false) => ({ id, date: wib(at), user_id: user, content, has_replies: replies });
  const module = { id: 'cf1', name: 'Module', type: 'drop_down', type_config: { options: [{ id: 'o1', name: 'Billing', orderindex: 0 }, { id: 'o2', name: 'Auth', orderindex: 1 }] } };
  const t2 = { id: 't2', name: 'Fix login', url: 'https://app.clickup.com/t/t2', status: 'to do', assignees: [], list: { id: 'l1', name: 'Backlog' }, date_updated: String(wib('2026-10-05T09:00:00')) };
  const t1 = {
    id: 't1', custom_id: 'DEV-42', name: 'Rekap transaksi', url: 'https://app.clickup.com/t/t1', status: 'in progress',
    assignees: [{ id: 11, username: 'luz' }], due_date: String(wib('2026-10-12T04:00:00')), priority: 'high',
    list: { id: 'l1', name: 'Backlog' }, space: { id: 's1' }, description: 'Rekap **bulanan**', tags: ['finance'],
    date_created: String(wib('2026-10-01T08:00:00')), date_updated: String(wib('2026-10-09T09:00:00')), time_estimate: 7200000,
    checklists: [{ id: 'ck1', name: 'QA', items: [{ id: 'i1', name: 'cek total', resolved: false }] }],
    custom_fields: [{ ...module, value: 0 }, { id: 'cf2', name: 'Notes', type: 'text' }],
    dependencies: [{ task_id: 't1', depends_on: 't2' }],
    subtasks: [{ id: 't1a', name: 'Kumpulkan data', status: 'to do' }],
    attachments: [{ id: 'a1', title: 'old.pdf' }],
  };
  const t3 = { id: 't3', name: 'Client site', url: 'https://app.clickup.com/t/t3', status: 'open', assignees: [], date_updated: String(wib('2026-10-10T09:00:00')) };
  const tasks: Record<string, Record<string, any>> = { '900': { t1, 'DEV-42': t1, t2 }, '901': { t3 } };
  // Task t2 has 27 comments, k27 the newest: ClickUp gives 25 at a time, older ones after `start` and `start_id`.
  const many = Array.from({ length: 27 }, (_, i) => ({ id: `k${27 - i}`, comment_text: `note ${27 - i}`, user: { id: 11, username: 'luz' }, date: String(wib('2026-10-09T10:00:00') - i * 60_000) }));
  const lists: Record<string, any> = {
    l1: { id: 'l1', name: 'Backlog', space: { id: 's1', name: 'Engineering' }, statuses: [{ status: 'to do', type: 'open' }, { status: 'in progress', type: 'custom' }, { status: 'done', type: 'closed' }] },
    l2: { id: 'l2', name: 'Sprint 12', space: { id: 's1', name: 'Engineering' }, statuses: [{ status: 'to do', type: 'open' }, { status: 'review', type: 'custom' }] },
  };
  const teams: Record<string, any> = {
    '900': {
      name: 'Acme', members: [{ id: 11, username: 'luz', email: 'luz@example.com' }, { id: 22, username: 'sari', email: 'sari@example.com' }],
      channels: [{ id: 'c1', name: 'dev-team', type: 'CHANNEL', created_at: wib('2026-01-01T00:00:00') }, { id: 'c2', type: 'DM' }, { id: 'c9', name: 'later', type: 'CHANNEL', created_at: wib('2026-11-01T00:00:00') }],
      spaces: [{ id: 's1', name: 'Engineering', type: 'space', children: [
        { id: 'l1', name: 'Backlog', type: 'list' },
        { id: 'f1', name: 'Sprints', type: 'folder', children: [{ id: 'l2', name: 'Sprint 12', type: 'list' }] },
      ] }],
      filter: [t1, t2],
      entries: [
        { id: 'te2', user: { id: 11, username: 'luz' }, start: '2026-10-09 09:00', end: '2026-10-09 10:00', duration_ms: 3600000, description: '', billable: true },
        {
          id: 'te1', task: { id: 't1', name: 'Rekap transaksi' }, user: { id: 11, username: 'luz' }, start: String(wib('2026-10-08T19:00:00')),
          end: String(wib('2026-10-08T21:30:00')), duration_ms: 9000000, description: 'lembur rekap', billable: false, task_location: { list_name: 'Backlog' },
        },
      ],
      docs: [{ id: 'doc1', name: 'Runbook', url: 'https://app.clickup.com/900/v/dc/doc1', dateUpdated: wib('2026-10-07T10:00:00') }],
    },
    '901': {
      name: 'Side', members: [{ id: 11, username: 'luz' }, { id: 33, username: 'budi', email: 'budi@example.com' }],
      channels: [{ id: 'd1', type: 'DM' }], spaces: [], filter: [t3], entries: [], docs: [],
    },
  };
  // channel -> pages of messages, newest first; the cursor of a page is its number
  const pages: Record<string, any[][]> = {
    c1: [
      [msg('m4', '2026-10-10T10:00:00', ME, 'patch prod on saturday'), msg('m3', '2026-10-08T20:30:00', ME, 'still fixing the invoice export', true)],
      [msg('m2', '2026-10-08T14:00:00', '22', 'can you check invoices?'), msg('m1', '2026-10-08T10:00:00', ME, 'morning'), msg('m0', '2026-09-01T10:00:00', ME, 'way too old')],
    ],
    c2: [[msg('s1', '2026-08-01T09:00:00', '22', 'halo')]],
    c9: [[]],
    d1: [[msg('d1m', '2026-10-09T23:00:00', ME, 'fixing the client site'), msg('d0', '2026-10-09T22:00:00', '33', 'site is down')]],
  };
  const docPages = [{ id: 'p1', name: 'Deploy', pages: [{ id: 'p2', name: 'Rollback' }] }];
  const pageText: Record<string, any> = { p1: { id: 'p1', name: 'Deploy', content: '# Deploy\n\nsteps' }, p2: { id: 'p2', name: 'Rollback', content: 'undo' } };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  class Fail extends Error {}
  const no = (why: string): never => { throw new Fail(why); };

  function tool(name: string, a: any): unknown {
    const wsId = String(a.workspace_id ?? '900');
    const ws = teams[wsId] ?? no('Workspace not found or not accessible');
    const task = (id: string) => tasks[wsId]![id] ?? no(`Task ${id} not found`);
    const said = String(a.content ?? a.comment_text ?? '');
    if (said.startsWith('boom')) no('Something went wrong, try again later');
    if (said.startsWith('refuse')) no('You do not have permission to do this');
    switch (name) {
      case 'clickup_get_user': return { user: { id: 11, username: 'luz', email: 'luz@example.com', timezone: 'Asia/Jakarta' } };
      case 'clickup_get_workspace_hierarchy': {
        const spaces = (ws.spaces as any[]).filter((s) => !a.space_ids || a.space_ids.includes(s.id));
        if (a.space_ids && !spaces.length) no('Space not found');
        return { hierarchy: { root: { id: wsId, name: ws.name, type: 'workspace', children: a.max_depth === '0' ? [] : spaces } }, has_more: false };
      }
      case 'clickup_get_workspace_members': return { members: ws.members };
      case 'clickup_get_chat_channels': return { channels: ws.channels, has_more: false };
      case 'clickup_get_chat_channel_messages': {
        const all = (ws.channels as any[]).some((c) => c.id === a.channel_id) ? pages[a.channel_id]! : no('Channel not found');
        const n = Number(a.cursor ?? 0);
        if (n >= all.length) throw new Error('read past the start of the range');
        return { messages: all[n], has_more: n + 1 < all.length + (a.channel_id === 'c1' ? 1 : 0), next_cursor: String(n + 1) };
      }
      case 'clickup_get_chat_message_replies':
        return { replies: a.message_id === 'm3' ? [msg('r1', '2026-10-08T22:15:00', ME, 'done, deployed')] : [], has_more: false };
      case 'clickup_send_chat_message':
        return { success: true, message_id: 'new1', channel_id: a.channel_id ?? (a.user_ids ? 'c2' : 'c1') };
      case 'clickup_request_attachment_upload':
        if (a.task_id) task(a.task_id);
        return { success: true, upload_url: 'https://mcp.clickup.com/upload', upload_ticket: a.task_id ? `task:${a.task_id}` : a.channel_id ?? `reply:${a.parent_message_id}`, multipart_field: 'attachment' };
      case 'clickup_get_task': return task(a.task_id);
      case 'clickup_filter_tasks': {
        const page = Number(a.page ?? 0);
        return { tasks: page ? [] : ws.filter, has_more: false };
      }
      case 'clickup_get_task_comments': {
        task(a.task_id);
        if (a.task_id !== 't2') return { comments: a.task_id === 't1' ? [{ id: 'cm1', comment_text: 'sudah dicek', user: { id: 22, username: 'sari' }, date: String(wib('2026-10-09T09:00:00')), reply_count: 1 }] : [] };
        const at = a.start_id ? many.findIndex((c) => c.id === a.start_id && Number(c.date) === a.start) + 1 : 0;
        return { comments: a.start_id && !at ? [] : many.slice(at, at + 25) };
      }
      case 'clickup_get_list': return lists[a.list_id] ?? no('List not found');
      case 'clickup_get_custom_fields': return { list_fields: a.list_id === 'l1' ? [{ ...module, required: true }] : [], space_fields: [] };
      case 'clickup_get_time_entries': return { entries: (ws.entries as any[]).filter((e) => !a.task_id || e.task?.id === a.task_id) };
      case 'clickup_search': return { results: (ws.docs as any[]).filter((d) => !a.keywords || d.name.toLowerCase().includes(a.keywords.toLowerCase())) };
      case 'clickup_list_document_pages': return a.document_id === 'doc1' && wsId === '900' ? { pages: docPages } : no('Document not found');
      case 'clickup_get_document_pages': return { pages: (a.page_ids as string[]).map((id) => pageText[id]).filter(Boolean) };
      case 'clickup_create_task': return { task_id: 't9', task_url: 'https://app.clickup.com/t/t9' };
      case 'clickup_update_task': task(a.task_id); return { task_id: a.task_id, task_url: `https://app.clickup.com/t/${a.task_id}` };
      case 'clickup_move_task': case 'clickup_add_tag_to_task': case 'clickup_remove_tag_from_task':
      case 'clickup_add_task_dependency': case 'clickup_remove_task_dependency': case 'clickup_add_task_link': case 'clickup_remove_task_link':
        task(a.task_id); return { success: true };
      case 'clickup_create_comment': return { success: true, comment_id: a.reply_to_id ? 'cm10' : 'cm9' };
      case 'clickup_add_time_entry': return { success: true, timeEntry: { id: 'te9' } };
      case 'clickup_create_document': return { document_id: 'doc9', document_url: 'https://app.clickup.com/900/v/dc/doc9' };
      case 'clickup_create_document_page': return { page_id: 'p9' };
      case 'clickup_update_document_page': return { success: true };
      default: return undefined;
    }
  }

  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.hostname !== 'mcp.clickup.com') return json({ error: 'not ClickUp MCP' }, 404);
    if (url.pathname === '/oauth/register') {
      calls.push(`REGISTER ${JSON.parse(String(init?.body)).redirect_uris}`);
      return json({ client_id: 'client1' }, 201);
    }
    if (url.pathname === '/oauth/token') {
      const q = new URLSearchParams(String(init?.body));
      return q.get('code') === 'code1' && q.get('client_id') === 'client1' && q.get('code_verifier')
        ? json({ access_token: 'mcp_test', token_type: 'Bearer', expires_in: 315360000 }) : json({ error: 'invalid_grant' }, 400);
    }
    if (url.pathname === '/upload') {
      const f = (init?.body as FormData).get('attachment') as File;
      calls.push(`UPLOAD ${headers['x-upload-ticket']} ${f.name} ${f.size}`);
      const failing = /^bad-(\d{3})\./.exec(f.name);
      if (failing) return json({ error: 'upload failed' }, Number(failing[1]));
      // ClickUp says where a file on a task is, not one waiting for its message
      return json({ id: `f-${f.name}`, title: f.name, ...(String(headers['x-upload-ticket']).startsWith('task:') && { url: `https://files.example/${f.name}` }) });
    }
    if (url.pathname !== '/mcp') return json({ error: 'nope' }, 404);
    if (headers.authorization !== 'Bearer mcp_test') return json({ error: 'invalid_token' }, 401);
    const m = JSON.parse(String(init?.body));
    const { name, arguments: args } = m.params;
    calls.push(`${name} ${JSON.stringify(args)}`);
    const result = (o: unknown, isError = false) => {
      const body = { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(o) }], isError } };
      // answered as an event stream, as the real server does
      return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    try {
      const r = tool(name, args ?? {});
      return r === undefined ? json({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `unknown tool ${name}` } }) : result(r);
    } catch (e) {
      if (e instanceof Fail) return result({ error: e.message }, true);
      throw e;
    }
  }) as typeof fetch;
}

/** A ClickUp connected to the fake; a `token` other than `mcp_test` is refused. */
export const fakeClient = (calls?: string[], workspaceId?: string, token = 'mcp_test') =>
  new ClickUp({ token, workspaceId, fetch: fakeClickUp(calls) });

/** The calls that change something in ClickUp, and the uploads. */
export const changes = (calls: string[]) => calls.filter((c) => /^(UPLOAD |clickup_(send|create|update|move|add|remove)_)/.test(c));
