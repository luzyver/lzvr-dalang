import { describe, expect, it } from 'vitest';
import { ClickUp, ClickUpError, ClickUpUncertain } from '../src/clickup.js';
import { ClickUpWork } from '../src/clickup-work.js';
import { changes, fakeClickUp, fakeClient } from './fake-clickup.js';

const work = (calls?: string[], workspaceId?: string) => new ClickUpWork(fakeClient(calls, workspaceId));
/** A person who reads dates in another time zone than their ClickUp profile's (Asia/Jakarta). */
const abroad = (calls: string[], timeZone: string) => new ClickUpWork(new ClickUp({ token: 'mcp_test', timeZone, fetch: fakeClickUp(calls) }));
/** The arguments of the calls of a tool. */
const args = (calls: string[], tool: string) => calls.filter((c) => c.startsWith(`${tool} `)).map((c) => JSON.parse(c.slice(tool.length + 1)));
const file = (name: string) => ({ name, data: Buffer.from(name) });

describe('ClickUp work, reading', () => {
  it('lists spaces with their folders and lists, and one space by id', async () => {
    const w = work();
    expect(await w.spaces()).toEqual([{
      id: 's1', name: 'Engineering', workspace_id: '900', workspace: 'Acme',
      lists: [{ id: 'l1', name: 'Backlog' }], folders: [{ id: 'f1', name: 'Sprints', lists: [{ id: 'l2', name: 'Sprint 12' }] }],
    }]);
    expect(await w.spaces(undefined, 's1')).toHaveLength(1);
    expect(await w.spaces(['901'])).toEqual([]);
    await expect(w.spaces(undefined, 'nope')).rejects.toThrow(/no space nope/);
  });

  it('describes a list: statuses and custom fields with their options', async () => {
    expect(await work().list('l1')).toEqual({
      id: 'l1', name: 'Backlog', space: 'Engineering',
      statuses: [{ status: 'to do', type: 'open' }, { status: 'in progress', type: 'custom' }, { status: 'done', type: 'closed' }],
      custom_fields: [{ id: 'cf1', name: 'Module', type: 'drop_down', required: true, options: [{ id: 'o1', name: 'Billing' }, { id: 'o2', name: 'Auth' }] }],
    });
    await expect(work().list('nope')).rejects.toThrow(/no list nope/);
  });

  it('finds tasks with the filters as ClickUp takes them, and by part of the name or custom id', async () => {
    const calls: string[] = [];
    const w = work(calls, '900');
    const r = await w.findTasks({ assignees: ['me'], listIds: ['l1', 'l2'], statuses: ['in progress'], dueFrom: '2026-10-01', dueTo: '2026-10-31' });
    expect(r.tasks.map((t: any) => t.id)).toEqual(['t1', 't2']);
    expect(r.tasks[0]).toEqual({
      id: 't1', custom_id: 'DEV-42', name: 'Rekap transaksi', status: 'in progress', assignees: ['luz'], due: '2026-10-12', priority: 'high',
      list: 'Backlog', url: 'https://app.clickup.com/t/t1',
    });
    expect(args(calls, 'clickup_filter_tasks')).toEqual([{
      order_by: 'updated', subtasks: false, include_closed: false, list_ids: ['l1', 'l2'], statuses: ['in progress'], assignees: ['11'],
      due_date_from: '2026-10-01', due_date_to: '2026-10-31', page: 0, workspace_id: '900',
    }]);

    expect((await w.findTasks({ query: 'login' })).tasks.map((t: any) => t.id)).toEqual(['t2']);
    expect((await w.findTasks({ query: 'dev-4' })).tasks.map((t: any) => t.id)).toEqual(['t1']);
    expect((await w.findTasks({ updatedSince: '2026-10-06' })).tasks.map((t: any) => t.id)).toEqual(['t1']);
    // a last change given as an ISO date is read as one; a task that does not say is kept, not taken as older than all
    expect((await work([], '902').findTasks({ updatedSince: '2026-10-06' })).tasks.map((t: any) => t.id)).toEqual(['t8', 't7']);
    const one = await w.findTasks({ limit: 1 });
    expect(one.tasks).toHaveLength(1);
    expect(one.warnings?.join()).toMatch(/more tasks match/);
    await expect(w.findTasks({ dueFrom: 'soon' })).rejects.toThrow(/not a date/);
  });

  it('picks the last changed tasks of the workspaces asked for together, and gives a task\'s subtasks', async () => {
    const all = await work().findTasks({ workspaceIds: ['900', '901'] });
    expect(all.tasks.map((t: any) => `${t.id} ${t.workspace}`)).toEqual(['t3 Side', 't1 Acme', 't2 Acme']);
    expect(all.warnings).toBeUndefined();
    expect((await work().findTasks({ parent: 'DEV-42' })).tasks).toEqual([{ id: 't1a', name: 'Kumpulkan data', status: 'to do', parent: 't1', url: 'https://app.clickup.com/t/t1a' }]);
  });

  it('reads comments page by page up to the limit, saying when older ones are left', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const all: any = await w.task('t2', true);
    expect(all.comments).toHaveLength(27);
    expect(all.comments[26]).toMatchObject({ id: 'k1', text: 'note 1' });
    expect(all.comments_more).toBeUndefined();
    expect(args(calls, 'clickup_get_task_comments')).toHaveLength(2);
    expect(args(calls, 'clickup_get_task_comments')[1]).toMatchObject({ task_id: 't2', start_id: 'k3' });
    const some: any = await w.task('t2', true, 10);
    expect(some.comments.map((c: any) => c.id)).toEqual(Array.from({ length: 10 }, (_, i) => `k${27 - i}`));
    expect(some.comments_more).toBe(true);
  });

  it('reads a task in full, by id or custom id, with its comments on request', async () => {
    const t: any = await work().task('DEV-42', true);
    expect(t).toMatchObject({
      id: 't1', custom_id: 'DEV-42', status: 'in progress', due: '2026-10-12', priority: 'high', list_id: 'l1', space_id: 's1',
      created: '2026-10-01 08:00', updated: '2026-10-09 09:00', time_estimate_minutes: 120, tags: ['finance'], description: 'Rekap **bulanan**',
      custom_fields: [{ id: 'cf1', name: 'Module', type: 'drop_down', value: 'Billing' }],
      checklists: [{ id: 'ck1', name: 'QA', items: [{ id: 'i1', name: 'cek total', done: false }] }],
      subtasks: [{ id: 't1a', name: 'Kumpulkan data', status: 'to do' }], waiting_on: ['t2'], attachments: [{ name: 'old.pdf' }],
      comments: [{ id: 'cm1', date: '2026-10-09', time: '09:00', author: 'sari', text: 'sudah dicek', replies: 1 }],
    });
    expect((await work().task('t2') as any).comments).toBeUndefined();
    await expect(work().task('t404')).rejects.toThrow(/no task t404/);
  });

  it('sums time entries by day and in all, oldest first', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const r = await w.timeEntries({ from: '2026-10-08', to: '2026-10-09' });
    expect(r).toMatchObject({
      time_zone: 'Asia/Jakarta', total_minutes: 210, total: '3h 30m',
      days: [{ date: '2026-10-08', weekday: 'Thu', minutes: 150, total: '2h 30m' }, { date: '2026-10-09', weekday: 'Fri', minutes: 60, total: '1h 00m' }],
    });
    expect(r.entries[0]).toEqual({
      id: 'te1', date: '2026-10-08', weekday: 'Thu', start: '19:00', end: '21:30', minutes: 150, user: 'luz', task: 'Rekap transaksi', task_id: 't1',
      list: 'Backlog', description: 'lembur rekap',
    });
    expect(r.entries[1]).toMatchObject({ id: 'te2', start: '09:00', end: '10:00', billable: true });
    expect((await w.timeEntries({ from: '2026-10-09', to: '2026-10-09' })).entries.map((e) => e.id)).toEqual(['te2']); // only what is inside the range
    expect((await w.timeEntries({ from: '2026-10-08', to: '2026-10-09', task: 't1', assignees: ['22'] })).entries.map((e) => e.id)).toEqual(['te1']);
    expect(args(calls, 'clickup_get_time_entries')).toEqual([
      { start_date: '2026-10-08', end_date: '2026-10-09', workspace_id: '900' },
      { start_date: '2026-10-09', end_date: '2026-10-09', workspace_id: '900' },
      { start_date: '2026-10-08', end_date: '2026-10-09', assignee: ['22'], task_id: 't1', workspace_id: '900' },
    ]);
    await expect(w.timeEntries({ from: '2026-10-09', to: '2026-10-08' })).rejects.toThrow(/before/);
  });

  it('lists Docs, shows a Doc as a tree of pages and one page as text', async () => {
    const w = work();
    expect(await w.docs()).toEqual([{ id: 'doc1', name: 'Runbook', workspace_id: '900', workspace: 'Acme', url: 'https://app.clickup.com/900/v/dc/doc1', updated: '2026-10-07' }]);
    expect(await w.docs(undefined, 'zzz')).toEqual([]);
    expect(await w.doc('doc1')).toEqual({ doc_id: 'doc1', doc: 'Deploy', workspace: 'Acme', pages: [{ id: 'p1', name: 'Deploy', pages: [{ id: 'p2', name: 'Rollback' }] }] });
    expect(await w.doc('https://app.clickup.com/900/v/dc/doc1', 'p2')).toMatchObject({ doc_id: 'doc1', page: { id: 'p2', name: 'Rollback', content: 'undo' } });
    await expect(w.doc('nope')).rejects.toThrow(/no Doc nope/);
    await expect(w.doc('doc1', 'px')).rejects.toThrow(/no page px/);
  });
});

describe('ClickUp work, changing', () => {
  it('plans a new task without making it, and makes it when performed', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const plan = await w.planCreateTask({
      listId: 'l1', name: ' Laporan ', status: 'TO DO', priority: 'high', due: '2026-10-20', start: '2026-10-19 09:00', assignees: ['me', '22'], tags: ['x'],
      timeEstimateMinutes: 90, description: 'isi', customFields: [{ id: 'cf1', value: 'o2' }],
    });
    expect(plan.title).toBe('Create task "Laporan" in list "Backlog" (Engineering)');
    expect(plan.details.map((d) => `${d.label}: ${d.value}`)).toEqual([
      'Status: to do', 'Priority: high', 'Due: 2026-10-20', 'Start: 2026-10-19 09:00', 'Time estimate: 1h 30m', 'Description: isi', 'Assignees: luz, sari', 'Tags: x',
      'Field "Module": o2',
    ]);
    expect(changes(calls)).toEqual([]);
    expect(await w.perform(plan)).toMatchObject({ done: true, id: 't9', url: 'https://app.clickup.com/t/t9' });
    expect(args(calls, 'clickup_create_task')).toEqual([{
      name: 'Laporan', status: 'to do', priority: 'high', due_date: '2026-10-20', start_date: '2026-10-19 09:00', time_estimate: '90', markdown_description: 'isi',
      assignees: ['11', '22'], tags: ['x'], custom_fields: [{ id: 'cf1', value: 'o2' }], list_id: 'l1',
    }]);
  });

  it('gives ClickUp a time on the ClickUp user\'s clock, and a date alone as that date', async () => {
    const calls: string[] = [];
    const plan = await abroad(calls, 'Asia/Tokyo').planCreateTask({ listId: 'l1', name: 'x', due: '2026-10-20', start: '2026-10-19 09:00' });
    expect(plan.details.map((d) => `${d.label}: ${d.value}`)).toEqual(['Due: 2026-10-20', 'Start: 2026-10-19 09:00']);
    expect(plan.calls[0]!.args).toMatchObject({ due_date: '2026-10-20', start_date: '2026-10-19 07:00' });
  });

  it('refuses a plan that ClickUp would not take: an unknown list, status, person, field or date', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const make = (o: object) => w.planCreateTask({ listId: 'l1', name: 'x', ...o });
    await expect(make({ listId: 'nope' })).rejects.toThrow(/no list nope/);
    await expect(make({ status: 'review' })).rejects.toThrow(/no status "review" \(it has: to do, in progress, done\)/);
    await expect(make({ assignees: ['99'] })).rejects.toThrow(/no person 99/);
    await expect(make({ customFields: [{ id: 'cfx', value: 1 }] })).rejects.toThrow(/no custom field cfx/);
    await expect(make({ due: 'soon' })).rejects.toThrow(/not a date/);
    await expect(make({ due: '2026-02-31' })).rejects.toThrow(/no such date/);
    await expect(make({ name: ' ' })).rejects.toThrow(/name is empty/);
    expect(changes(calls)).toEqual([]);
  });

  it('changes a task, saying what was and what will be', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const plan = await w.planUpdateTask({
      task: 't1', status: 'done', priority: 'none', due: '', addAssignees: ['22'], removeAssignees: ['me'], addTags: ['urgent fix'], removeTags: ['finance'],
      customFields: [{ id: 'cf1', value: null }],
    });
    expect(plan).toMatchObject({ title: 'Change task "Rekap transaksi"', url: 'https://app.clickup.com/t/t1' });
    expect(plan.details.map((d) => `${d.label}: ${d.value}`)).toEqual([
      'Status: in progress → done', 'Priority: high → none', 'Due: 2026-10-12 → none', 'Assign: sari', 'Unassign: luz', 'Field "Module": cleared',
      'Add tags: urgent fix', 'Remove tags: finance',
    ]);
    expect(changes(calls)).toEqual([]);
    expect(await w.perform(plan)).toMatchObject({ done: true, id: 't1', url: 'https://app.clickup.com/t/t1' });
    expect(changes(calls)).toEqual([
      'clickup_update_task {"task_id":"t1","status":"done","priority":"none","due_date":"none","assignees":["22"],"custom_fields":[{"id":"cf1","value":""}]}',
      'clickup_add_tag_to_task {"task_id":"t1","tag_name":"urgent fix"}',
      'clickup_remove_tag_from_task {"task_id":"t1","tag_name":"finance"}',
    ]);
    await expect(w.planUpdateTask({ task: 't1' })).rejects.toThrow(/nothing to change/);
    await expect(w.planUpdateTask({ task: 't1', status: 'review' })).rejects.toThrow(/no status "review"/);
  });

  it('moves a task to another list only with a status both lists have', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const tools = (p: { calls: { tool: string; args: any }[] }) => p.calls.map((c) => `${c.tool} ${JSON.stringify(c.args)}`);
    expect(tools(await w.planUpdateTask({ task: 't2', moveToList: 'l2' }))).toEqual(['clickup_move_task {"task_id":"t2","list_id":"l2"}']);
    await expect(w.planUpdateTask({ task: 't1', moveToList: 'l2' })).rejects.toThrow(/list "Sprint 12" has no status "in progress": give the status/);
    await expect(w.planUpdateTask({ task: 't1', moveToList: 'l2', status: 'review' })).rejects.toThrow(/both have: to do/);
    const plan = await w.planUpdateTask({ task: 't1', moveToList: 'l2', status: 'to do', name: 'Rekap' });
    expect(tools(plan)).toEqual([
      'clickup_update_task {"task_id":"t1","status":"to do"}', 'clickup_move_task {"task_id":"t1","list_id":"l2"}', 'clickup_update_task {"task_id":"t1","name":"Rekap"}',
    ]);
    expect(plan.details.map((d) => `${d.label}: ${d.value}`)).toEqual(['Name: Rekap transaksi → Rekap', 'Status: in progress → to do', 'Move to list: Backlog → Sprint 12']);
    expect(changes(calls)).toEqual([]);
  });

  it('comments on a task, or replies to one of its comments', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const plan = await w.planComment({ task: 'DEV-42', text: ' beres ', assignee: '22', notifyAll: true });
    expect(plan.title).toBe('Comment on task "Rekap transaksi"');
    expect(plan.details).toEqual([{ label: 'Assign the comment to', value: 'sari' }, { label: 'Comment', value: 'beres' }]);
    expect(await w.perform(plan)).toMatchObject({ done: true, id: 'cm9' });
    const reply = await w.planComment({ task: 't1', text: 'ok', replyTo: 'cm1' });
    expect(reply.details[0]).toEqual({ label: 'Reply to', value: 'sari: sudah dicek' });
    expect(await w.perform(reply)).toMatchObject({ id: 'cm10' });
    expect(args(calls, 'clickup_create_comment')).toEqual([
      { entity_type: 'task', entity_id: 't1', comment_text: 'beres', notify_all: true, assignee: '22' },
      { entity_type: 'task', entity_id: 't1', comment_text: 'ok', notify_all: false, reply_to_id: 'cm1' },
    ]);
    await expect(w.planComment({ task: 't1', text: 'ok', replyTo: 'zz' })).rejects.toThrow(/comment zz is not among/);
    await expect(w.planComment({ task: 't1', text: ' ' })).rejects.toThrow(/empty/);
  });

  it('attaches files to a task, alone or named at the end of a comment, and says what is on the task when a later step fails', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const task = await fakeClient().task('t1');
    const note = await w.planComment({ task: 't1', text: 'lihat', files: [{ name: 'shot.png', size: 8 }] });
    expect(note.details.at(-1)).toEqual({ label: 'Files', value: 'shot.png (8 B): attached to the task, named at the end of the comment' });
    expect(await w.perform(note, [file('shot.png')], task)).toMatchObject({ done: true, id: 'cm9', attached: 1 });
    expect(changes(calls)).toEqual([
      'UPLOAD task:t1 shot.png 8',
      `clickup_create_comment ${JSON.stringify({ entity_type: 'task', entity_id: 't1', comment_text: 'lihat\n\n📎 [shot.png](https://files.example/shot.png)', notify_all: false })}`,
    ]);

    const alone = await w.planAttach({ task: 't1', files: [{ name: 'a.xlsx', size: 6 }] });
    expect(alone).toMatchObject({ title: 'Attach a file to task "Rekap transaksi"', calls: [] });
    expect(await w.perform(alone, [file('a.xlsx')], task)).toMatchObject({ done: true, url: 'https://app.clickup.com/t/t1', attached: 1 });
    await expect(w.perform(alone)).rejects.toThrow(/nothing to do/);
    await expect(w.perform(alone, [file('a.xlsx')])).rejects.toThrow(/need a task/);

    // the file is on the task, the comment is not known to be: said, so nobody uploads it twice
    const cut = await w.perform(await w.planComment({ task: 't1', text: 'boom' }), [file('a.xlsx')], task).catch((e) => e);
    expect(cut).toBeInstanceOf(ClickUpUncertain);
    expect(cut.message).toMatch(/posting the comment failed.*Already on task "Rekap transaksi".*a\.xlsx/);
  });

  it('calls a step ClickUp refused failed and any other failure uncertain, naming the steps already done', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const refused = await w.perform(await w.planDoc({ name: 'Catatan', content: 'refuse me' })).catch((e) => e);
    expect(refused).toBeInstanceOf(ClickUpError);
    expect(refused).not.toBeInstanceOf(ClickUpUncertain);
    expect(refused.message).toMatch(/writing its page failed: .*permission.*Already done: creating the Doc\./);
    const cut = await w.perform(await w.planDoc({ name: 'Catatan', content: 'boom' })).catch((e) => e);
    expect(cut).toBeInstanceOf(ClickUpUncertain);
    expect(cut.message).toMatch(/Already done: creating the Doc\. Check ClickUp before asking again/);
    // a change kept from before ClickUp went through its own MCP server cannot run
    const old = { title: 'x', details: [], calls: [{ method: 'POST', path: '/api/v2/task/t1/comment', what: 'posting' }] } as never;
    await expect(w.perform(old)).rejects.toThrow(/reject it and ask again/);
    expect(changes(calls).map((c) => c.split(' ')[0])).toEqual(['clickup_create_document', 'clickup_create_document_page', 'clickup_create_document', 'clickup_create_document_page']);
  });

  it('ties tasks and takes a tie away', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const wait = await w.planLink({ task: 't1', other: 't2', kind: 'waits_on' });
    expect(wait.title).toBe('Make task "Rekap transaksi" wait on "Fix login"');
    await w.perform(wait);
    await w.perform(await w.planLink({ task: 't1', other: 't2', kind: 'blocks', remove: true }));
    await w.perform(await w.planLink({ task: 't1', other: 't2', kind: 'link' }));
    expect(changes(calls)).toEqual([
      'clickup_add_task_dependency {"task_id":"t1","depends_on":"t2","type":"waiting_on"}',
      'clickup_remove_task_dependency {"task_id":"t1","depends_on":"t2","type":"blocking"}',
      'clickup_add_task_link {"task_id":"t1","links_to":"t2"}',
    ]);
    await expect(w.planLink({ task: 't1', other: 'DEV-42', kind: 'link' })).rejects.toThrow(/itself/);
  });

  it('logs time on a task, by the offset of that time on the day the clocks change too', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const plan = await w.planLogTime({ task: 't1', date: '2026-10-08', start: '19:00', minutes: 150, description: 'lembur', billable: true });
    expect(plan.title).toBe('Log 2h 30m on task "Rekap transaksi"');
    expect(plan.details[0]).toEqual({ label: 'When', value: '2026-10-08 19:00 to 21:30 (2h 30m)' });
    expect(await w.perform(plan)).toMatchObject({ done: true, id: 'te9' });
    expect(args(calls, 'clickup_add_time_entry')).toEqual([{ task_id: 't1', start: '2026-10-08 19:00', duration: '150m', description: 'lembur', billable: true }]);
    await expect(w.planLogTime({ task: 't1', date: '2026-10-08', start: '7pm', minutes: 5 })).rejects.toThrow(/time like 09:30/);
    await expect(w.planLogTime({ task: '', date: '2026-10-08', start: '07:00', minutes: 5 })).rejects.toThrow(/give the task/);
    // 03:30 in Amsterdam on the day summer time starts is 01:30 UTC, 08:30 on the ClickUp user's clock
    const dst = await abroad([], 'Europe/Amsterdam').planLogTime({ task: 't1', date: '2026-03-29', start: '03:30', minutes: 60 });
    expect(dst.calls[0]!.args).toMatchObject({ start: '2026-03-29 08:30' });
    expect(dst.details[0]!.value).toBe('2026-03-29 03:30 to 04:30 (1h 00m)');
  });

  it('writes Docs: a new Doc with its first page, a new page, a page changed', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const made = await w.planDoc({ name: 'Catatan', content: '# isi' });
    expect(made).toMatchObject({ title: 'Create Doc "Catatan" in Acme', details: [{ label: 'Seen by', value: 'only you, until shared' }, { label: 'Text', value: '# isi' }] });
    expect(await w.perform(made)).toMatchObject({ done: true, id: 'doc9', url: 'https://app.clickup.com/900/v/dc/doc9' });
    await w.perform(await w.planDoc({ name: 'Kosong', visibility: 'public' }));
    await w.perform(await w.planDoc({ docId: 'doc1', name: 'FAQ', content: 'q', parentPageId: 'p1' }));
    const edit = await w.planDoc({ docId: 'doc1', pageId: 'p1', content: 'more', mode: 'append', name: 'Deploy v2' });
    expect(edit).toMatchObject({ title: 'Change page "Deploy" of Deploy', details: [{ label: 'Rename to', value: 'Deploy v2' }, { label: 'Add at its end', value: 'more' }] });
    await w.perform(edit);
    expect(changes(calls)).toEqual([
      'clickup_create_document {"name":"Catatan","parent":{"id":"900","type":12},"visibility":"PRIVATE","create_page":false,"workspace_id":"900"}',
      'clickup_create_document_page {"document_id":"doc9","name":"Catatan","content":"# isi","content_format":"text/md","workspace_id":"900"}',
      'clickup_create_document {"name":"Kosong","parent":{"id":"900","type":12},"visibility":"PUBLIC","create_page":true,"workspace_id":"900"}',
      'clickup_create_document_page {"document_id":"doc1","name":"FAQ","content":"q","content_format":"text/md","parent_page_id":"p1","workspace_id":"900"}',
      'clickup_update_document_page {"document_id":"doc1","page_id":"p1","name":"Deploy v2","content":"more","content_edit_mode":"append","content_format":"text/md","workspace_id":"900"}',
    ]);
    await expect(w.planDoc({})).rejects.toThrow(/give name for a new Doc/);
    await expect(w.planDoc({ docId: 'doc1' })).rejects.toThrow(/give name for a new page/);
    await expect(w.planDoc({ docId: 'doc1', pageId: 'p1' })).rejects.toThrow(/give content or name/);
    await expect(w.planDoc({ docId: 'nope', name: 'x' })).rejects.toThrow(/no Doc nope/);
  });
});
