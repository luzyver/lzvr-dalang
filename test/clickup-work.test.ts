import { describe, expect, it } from 'vitest';
import { ClickUp, ClickUpError, ClickUpUncertain } from '../src/clickup.js';
import { ClickUpWork } from '../src/clickup-work.js';
import { fakeClickUp, fakeClient, wib } from './fake-clickup.js';

const work = (calls?: string[], workspaceId?: string) => new ClickUpWork(fakeClient(calls, workspaceId));
/** The changes made: every request but the reads. */
const changes = (calls: string[]) => calls.filter((c) => /^(POST|PUT|DELETE) /.test(c));

describe('ClickUp work, reading', () => {
  it('lists spaces with their folders and lists, and one space by id', async () => {
    const w = work();
    expect(await w.spaces()).toEqual([{
      id: 's1', name: 'Engineering', workspace_id: '900', workspace: 'Acme',
      lists: [{ id: 'l1', name: 'Backlog', tasks: 2 }],
      folders: [{ id: 'f1', name: 'Sprints', lists: [{ id: 'l2', name: 'Sprint 12', tasks: 3 }] }],
    }]);
    expect(await w.spaces(undefined, 's1')).toHaveLength(1);
    await expect(w.spaces(undefined, 'nope')).rejects.toThrow(/no space nope/);
  });

  it('describes a list: statuses and custom fields with their options, a hidden folder left out', async () => {
    const l = await work().list('l1');
    expect(l).toEqual({
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
    const asked = new URL(`https://x${calls.find((c) => c.startsWith('/api/v2/team/900/task'))}`).searchParams;
    expect(asked.getAll('list_ids[]')).toEqual(['l1', 'l2']);
    expect(asked.getAll('assignees[]')).toEqual(['11']);
    expect(asked.getAll('statuses[]')).toEqual(['in progress']);
    expect(Number(asked.get('due_date_gt'))).toBe(wib('2026-10-01T00:00:00') - 1);
    expect(Number(asked.get('due_date_lt'))).toBe(wib('2026-11-01T00:00:00'));
    expect(asked.get('include_closed')).toBeNull();

    expect((await w.findTasks({ query: 'login' })).tasks.map((t: any) => t.id)).toEqual(['t2']);
    expect((await w.findTasks({ query: 'dev-4' })).tasks.map((t: any) => t.id)).toEqual(['t1']);
    const one = await w.findTasks({ limit: 1 });
    expect(one.tasks).toHaveLength(1);
    expect(one.warnings?.join()).toMatch(/more tasks match/);
    await expect(w.findTasks({ dueFrom: 'soon' })).rejects.toThrow(/not a date/);
  });

  it('picks the last changed tasks of all workspaces together, not those of the first one read', async () => {
    const all = await work().findTasks({});
    expect(all.tasks.map((t: any) => `${t.id} ${t.workspace}`)).toEqual(['t3 Side', 't1 Acme', 't2 Acme']);
    expect(all.warnings).toBeUndefined();
    const one = await work().findTasks({ limit: 1 });
    expect(one.tasks.map((t: any) => t.id)).toEqual(['t3']);
    expect(one.warnings?.join()).toMatch(/more tasks match/);
  });

  it('refuses a bare custom id that is a task in two workspaces', async () => {
    await expect(work().task('DUP-1')).rejects.toThrow(/DUP-1 is a task in 2 workspaces \(Acme, Side\); give its link/);
    expect(await work().task('https://app.clickup.com/t/901/DUP-1')).toMatchObject({ id: 't3' });
  });

  it('reads comments page by page up to the limit, saying when older ones are left', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const all: any = await w.task('t2', true);
    expect(all.comments.map((c: any) => c.id)).toEqual(Array.from({ length: 27 }, (_, i) => `k${27 - i}`));
    expect(all).not.toHaveProperty('comments_more');
    expect(calls.filter((c) => c.startsWith('/api/v2/task/t2/comment'))).toEqual([
      '/api/v2/task/t2/comment', `/api/v2/task/t2/comment?start=${wib('2026-10-09T10:00:00') - 24 * 60_000}&start_id=k3`,
    ]);
    const some: any = await w.task('t2', true, 25);
    expect(some.comments).toHaveLength(25);
    expect(some.comments_more).toBe(true);
    // A comment older than the first page can still be replied to.
    expect((await w.planComment({ task: 't2', text: 'ok', replyTo: 'k1' })).calls[0]!.path).toBe('/api/v2/comment/k1/reply');
  });

  it('reads a task in full, by id or custom id, with its comments on request', async () => {
    const t: any = await work().task('DEV-42', true);
    expect(t).toMatchObject({
      id: 't1', workspace_id: '900', list_id: 'l1', due: '2026-10-12', description: 'Rekap **bulanan**', tags: ['finance'], time_estimate_minutes: 120,
      created: '2026-10-01 08:00', custom_fields: [{ id: 'cf1', name: 'Module', type: 'drop_down', value: 'Billing' }],
      checklists: [{ id: 'ck1', name: 'QA', items: [{ id: 'i1', name: 'cek total', done: false }] }], waiting_on: ['t2'],
      comments: [{ id: 'cm1', date: '2026-10-09', time: '09:00', author: 'sari', text: 'sudah dicek', replies: 1 }],
    });
    expect(await work().task('t2')).not.toHaveProperty('comments');
    await expect(work().task('t404')).rejects.toThrow(/no task t404/);
  });

  it('sums time entries by day and in all, oldest first', async () => {
    const r = await work(undefined, '900').timeEntries({ from: '2026-10-08', to: '2026-10-09' });
    expect(r).toMatchObject({ time_zone: 'Asia/Jakarta', total_minutes: 210, total: '3h 30m' });
    expect(r.days).toEqual([
      { date: '2026-10-08', weekday: 'Thu', minutes: 150, total: '2h 30m' },
      { date: '2026-10-09', weekday: 'Fri', minutes: 60, total: '1h 00m' },
    ]);
    expect(r.entries[0]).toMatchObject({ id: 'te1', start: '19:00', end: '21:30', minutes: 150, task_id: 't1', list: 'Backlog', description: 'lembur rekap' });
    expect(r.entries[1]).toMatchObject({ id: 'te2', billable: true });
    await expect(work().timeEntries({ from: '2026-10-09', to: '2026-10-08' })).rejects.toThrow(/before from/);
    await expect(work().timeEntries({ from: '2026-01-01', to: '2026-10-08' })).rejects.toThrow(/at most/);
  });

  it('lists Docs, shows a Doc as a tree of pages and one page as text', async () => {
    const w = work();
    expect(await w.docs()).toEqual([{ id: 'doc1', name: 'Runbook', workspace_id: '900', workspace: 'Acme', updated: '2026-10-07' }]);
    expect(await w.docs(undefined, 'nothing')).toEqual([]);
    expect(await w.doc('doc1')).toEqual({
      doc_id: 'doc1', doc: 'Runbook', workspace: 'Acme', pages: [{ id: 'p1', name: 'Deploy', pages: [{ id: 'p2', name: 'Rollback' }] }],
    });
    expect(await w.doc('doc1', 'p1')).toMatchObject({ page: { id: 'p1', name: 'Deploy', content: '# Deploy\n\nsteps' } });
    await expect(w.doc('doc1', 'p9')).rejects.toThrow(/no page p9/);
    await expect(w.doc('nope')).rejects.toThrow(/no Doc nope/);
  });
});

describe('ClickUp work, changing', () => {
  it('plans a new task without making it, and makes it when performed', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const a = await w.planCreateTask({
      listId: 'l1', name: ' Audit log ', status: 'In Progress', priority: 'urgent', due: '2026-10-20', assignees: ['me', '22'], tags: ['ops'],
      description: 'what **changed**', customFields: [{ id: 'cf1', value: 'o2' }],
    });
    expect(a.title).toBe('Create task "Audit log" in list "Backlog" (Engineering)');
    expect(a.details).toEqual([
      { label: 'Status', value: 'in progress' }, { label: 'Priority', value: 'urgent' }, { label: 'Due', value: '2026-10-20' },
      { label: 'Description', value: 'what **changed**' }, { label: 'Assignees', value: 'luz, sari' }, { label: 'Tags', value: 'ops' },
      { label: 'Field "Module"', value: 'o2' },
    ]);
    expect(changes(calls)).toEqual([]);
    expect(await w.perform(a)).toMatchObject({ done: true, id: 't9', url: 'https://app.clickup.com/t/t9' });
    expect(changes(calls)).toEqual([`POST /api/v2/list/l1/task ${JSON.stringify({
      name: 'Audit log', status: 'in progress', priority: 1, due_date: wib('2026-10-20T04:00:00'), due_date_time: false,
      markdown_content: 'what **changed**', assignees: [11, 22], tags: ['ops'], custom_fields: [{ id: 'cf1', value: 'o2' }],
    })}`]);
  });

  it('refuses a plan that ClickUp would not take: an unknown list, status, person, field or date', async () => {
    const w = work();
    await expect(w.planCreateTask({ listId: 'nope', name: 'x' })).rejects.toThrow(/no list nope/);
    await expect(w.planCreateTask({ listId: 'l1', name: 'x', status: 'review' })).rejects.toThrow(/no status "review" \(it has: to do, in progress, done\)/);
    await expect(w.planCreateTask({ listId: 'l1', name: 'x', assignees: ['77'] })).rejects.toThrow(/no person 77/);
    await expect(w.planCreateTask({ listId: 'l1', name: 'x', customFields: [{ id: 'cf9', value: 1 }] })).rejects.toThrow(/no custom field cf9/);
    await expect(w.planCreateTask({ listId: 'l1', name: 'x', due: 'tomorrow' })).rejects.toThrow(/not a date/);
    await expect(w.planUpdateTask({ task: 't1' })).rejects.toThrow(/nothing to change/);
    for (const p of [w.planCreateTask({ listId: 'nope', name: 'x' }), w.planUpdateTask({ task: 't404', name: 'x' })]) {
      const e = await p.catch((x) => x);
      expect(e).toBeInstanceOf(ClickUpError);
    }
  });

  it('changes a task in one request per kind of change, saying what was and what will be', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const a = await w.planUpdateTask({
      task: 'DEV-42', status: 'Review', due: '2026-10-15 14:30', priority: 'none', addAssignees: ['22'], removeAssignees: ['me'],
      addTags: ['urgent fix'], removeTags: ['finance'], customFields: [{ id: 'cf1', value: 'o2' }], moveToList: 'l2',
    });
    expect(a).toMatchObject({ title: 'Change task "Rekap transaksi"', url: 'https://app.clickup.com/t/t1' });
    expect(a.details).toEqual([
      { label: 'Status', value: 'in progress → review' }, { label: 'Priority', value: 'high → none' }, { label: 'Due', value: '2026-10-12 → 2026-10-15 14:30' },
      { label: 'Assign', value: 'sari' }, { label: 'Unassign', value: 'luz' }, { label: 'Move to list', value: 'Backlog → Sprint 12' },
      { label: 'Add tags', value: 'urgent fix' }, { label: 'Remove tags', value: 'finance' }, { label: 'Field "Module"', value: 'o2' },
    ]);
    expect(await w.perform(a)).toMatchObject({ done: true, url: 'https://app.clickup.com/t/t1' });
    // The move first, with the status the new list lacks mapped to the one asked for; then what is set in that list.
    expect(changes(calls)).toEqual([
      'PUT /api/v3/workspaces/900/tasks/t1/home_list/l2 {"status_mappings":[{"source_status_id":"st2","destination_status_id":"sp2"}]}',
      `PUT /api/v2/task/t1 ${JSON.stringify({ status: 'review', priority: null, due_date: wib('2026-10-15T14:30:00'), due_date_time: true, assignees: { add: [22], rem: [11] } })}`,
      'POST /api/v2/task/t1/tag/urgent%20fix undefined',
      'DELETE /api/v2/task/t1/tag/finance',
      'POST /api/v2/task/t1/field/cf1 {"value":"o2"}',
    ]);
    await expect(w.planUpdateTask({ task: 't1', moveToList: 'l2' })).rejects.toThrow(/list "Sprint 12" has no status "in progress": give the status .*to do, review/);
    await expect(w.planUpdateTask({ task: 't1', moveToList: 'l2', status: 'done' })).rejects.toThrow(/no status "done" \(it has: to do, review\)/);
    expect((await w.planUpdateTask({ task: 't2', moveToList: 'l2' })).calls).toMatchObject([{ path: '/api/v3/workspaces/900/tasks/t2/home_list/l2', body: {} }]);
    const cleared = await w.planUpdateTask({ task: 't1', due: '', archived: true });
    expect(cleared.calls).toEqual([{ method: 'PUT', path: '/api/v2/task/t1', body: { due_date: null, archived: true }, what: 'changing the task' }]);
  });

  it('comments on a task, or replies to one of its comments', async () => {
    const calls: string[] = [];
    const w = work(calls);
    await w.perform(await w.planComment({ task: 't1', text: ' beres ', assignee: '22' }));
    const reply = await w.planComment({ task: 't1', text: 'ok', replyTo: 'cm1' });
    expect(reply.details).toEqual([{ label: 'Reply to', value: 'sari: sudah dicek' }, { label: 'Comment', value: 'ok' }]);
    await w.perform(reply);
    expect(changes(calls)).toEqual([
      'POST /api/v2/task/t1/comment {"comment_text":"beres","notify_all":false,"assignee":22}',
      'POST /api/v2/comment/cm1/reply {"comment_text":"ok","notify_all":false}',
    ]);
    await expect(w.planComment({ task: 't1', text: 'ok', replyTo: 'cm404' })).rejects.toThrow(/comment cm404 is not among/);
    await expect(w.planComment({ task: 't1', text: '  ' })).rejects.toThrow(/empty/);
  });

  it('attaches files to a task, alone or linked at the end of a comment, and says what is on the task when a later step fails', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const task = { id: 't1', name: 'Rekap transaksi', url: 'https://app.clickup.com/t/t1' };
    const file = (name: string, body = 'bytes') => ({ name, data: Buffer.from(body) });
    const sent = () => calls.filter((c) => /^(POST|UPLOAD) /.test(c));

    const note = await w.planComment({ task: 't1', text: 'lihat gambar', files: [{ name: 'shot.png', size: 2048 }] });
    expect(note.details).toEqual([
      { label: 'Comment', value: 'lihat gambar' },
      { label: 'Files', value: 'shot.png (2 KB): attached to the task, linked at the end of the comment' },
    ]);
    expect(await w.perform(note, [file('shot.png')], task)).toMatchObject({ done: true, id: 'cm9', attached: 1 });
    const alone = await w.planAttach({ task: 'DEV-42', files: [{ name: 'a.pdf', size: 5 }, { name: 'b.pdf', size: 3 * 1024 * 1024 }] });
    expect(alone).toMatchObject({ title: 'Attach 2 files to task "Rekap transaksi"', details: [{ label: 'Files', value: 'a.pdf (5 B), b.pdf (3.0 MB)' }], calls: [] });
    expect(await w.perform(alone, [file('a.pdf'), file('b.pdf')], task)).toMatchObject({ done: true, id: null, url: 'https://app.clickup.com/t/t1', attached: 2 });
    expect(sent()).toEqual([
      'UPLOAD /api/v2/task/t1/attachment shot.png 5',
      `POST /api/v2/task/t1/comment ${JSON.stringify({ notify_all: false, comment: [{ text: 'lihat gambar\n', attributes: {} }, { text: '\n📎 ', attributes: {} }, { text: 'shot.png', attributes: { link: 'https://files.example/shot.png' } }] })}`,
      'UPLOAD /api/v2/task/t1/attachment a.pdf 5',
      'UPLOAD /api/v2/task/t1/attachment b.pdf 5',
    ]);

    // A refused upload did nothing; the comment is not posted without its files.
    const before = sent().length;
    const refusedUpload = await w.perform(note, [file('bad-400.png')], task).catch((e) => e);
    expect(refusedUpload).toBeInstanceOf(ClickUpError);
    expect(refusedUpload).not.toBeInstanceOf(ClickUpUncertain);
    expect(sent().slice(before)).toEqual(['UPLOAD /api/v2/task/t1/attachment bad-400.png 5']);
    expect(await w.perform(note, [file('shot.png'), file('bad-502.png')], task).catch((e) => e)).toBeInstanceOf(ClickUpUncertain);
    // A step refused after the upload names the files that stay on the task.
    const late = await w.perform({ title: 'x', details: [], calls: [{ method: 'POST', path: '/api/v2/task/t1/nope', body: { comment_text: 'a' }, what: 'posting', links: 'comment_text' }] }, [file('shot.png')], task).catch((e) => e);
    expect(late.message).toMatch(/posting failed.*Already on task "Rekap transaksi" \(https:\/\/app\.clickup\.com\/t\/t1\): 📎 \[shot\.png\]/);
    await expect(w.perform(alone)).rejects.toThrow(/nothing to do/);
    await expect(w.perform(note, [file('shot.png')])).rejects.toThrow(/files need a task/);
  });

  it('adds a checklist and puts its items in the one ClickUp just made; ticks an item of one there', async () => {
    const calls: string[] = [];
    const w = work(calls);
    await w.perform(await w.planChecklist({ task: 't1', name: 'Release', items: ['tag', 'deploy'] }));
    await w.perform(await w.planChecklist({ task: 't1', checklistId: 'ck1', itemId: 'i1', done: true }));
    expect(changes(calls)).toEqual([
      'POST /api/v2/task/t1/checklist {"name":"Release"}',
      'POST /api/v2/checklist/ck9/checklist_item {"name":"tag"}',
      'POST /api/v2/checklist/ck9/checklist_item {"name":"deploy"}',
      'PUT /api/v2/checklist/ck1/checklist_item/i1 {"resolved":true}',
    ]);
    await expect(w.planChecklist({ task: 't1', checklistId: 'ck404', items: ['x'] })).rejects.toThrow(/no checklist ck404/);
    await expect(w.planChecklist({ task: 't1', checklistId: 'ck1', itemId: 'i404', done: true })).rejects.toThrow(/no item i404/);
    await expect(w.planChecklist({ task: 't1' })).rejects.toThrow(/give name/);
  });

  it('calls a step ClickUp refused failed and any other failure uncertain, naming the steps already done', async () => {
    const w = work();
    const refusedStep = await w.perform(await w.planChecklist({ task: 't1', name: 'Release', items: ['tag', 'boom-400'] })).catch((e) => e);
    expect(refusedStep).toBeInstanceOf(ClickUpError);
    expect(refusedStep).not.toBeInstanceOf(ClickUpUncertain);
    expect(refusedStep.message).toMatch(/adding item "boom-400" failed.*Already done: creating the checklist, adding item "tag"\./);
    const cut = await w.perform(await w.planChecklist({ task: 't1', checklistId: 'ck1', items: ['boom-502'] })).catch((e) => e);
    expect(cut).toBeInstanceOf(ClickUpUncertain);
    expect(cut.message).toMatch(/Check ClickUp before asking again/);
    // A step whose path needs an id the step before did not give never starts.
    const lost = await w.perform({ title: 'x', details: [], calls: [
      { method: 'POST', path: '/api/v2/task/t1/comment', body: { comment_text: 'a' }, what: 'first' },
      { method: 'POST', path: '/api/v2/checklist/{0.checklist.id}/checklist_item', body: { name: 'b' }, what: 'second' },
    ] }).catch((e) => e);
    expect(lost.message).toMatch(/second could not start.*Already done: first\./);
  });

  it('ties tasks and takes a tie away', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const a = await w.planLink({ task: 't1', other: 't2', kind: 'waits_on' });
    expect(a.title).toBe('Make task "Rekap transaksi" wait on "Fix login"');
    await w.perform(a);
    await w.perform(await w.planLink({ task: 't1', other: 't2', kind: 'link', remove: true }));
    expect(changes(calls)).toEqual(['POST /api/v2/task/t1/dependency {"depends_on":"t2"}', 'DELETE /api/v2/task/t1/link/t2']);
    expect((await w.planLink({ task: 't1', other: 't2', kind: 'blocks', remove: true })).calls[0]).toMatchObject({ method: 'DELETE', query: { dependency_of: 't2' } });
    await expect(w.planLink({ task: 't1', other: 'DEV-42', kind: 'link' })).rejects.toThrow(/itself/);
  });

  it('logs time on a task in its workspace, and without a task only once the workspace is clear', async () => {
    const calls: string[] = [];
    const w = work(calls);
    const a = await w.planLogTime({ task: 't1', date: '2026-10-08', start: '19:00', minutes: 150, description: 'lembur' });
    expect(a).toMatchObject({ title: 'Log 2h 30m on task "Rekap transaksi"', details: [{ label: 'When', value: '2026-10-08 19:00 to 21:30 (2h 30m)' }, { label: 'Description', value: 'lembur' }] });
    expect(await w.perform(a)).toMatchObject({ done: true, id: 'te9' });
    expect(changes(calls)).toEqual([`POST /api/v2/team/900/time_entries ${JSON.stringify({ start: wib('2026-10-08T19:00:00'), duration: 9_000_000, tid: 't1', description: 'lembur' })}`]);
    await expect(w.planLogTime({ date: '2026-10-08', start: '19:00', minutes: 30 })).rejects.toThrow(/give workspace_id, or a task: there are 2 workspaces/);
    expect((await w.planLogTime({ date: '2026-10-08', start: '23:45', minutes: 30, workspaceId: '901' })).details[0]!.value).toBe('2026-10-08 23:45 to 2026-10-09 00:15 (0h 30m)');
    await expect(w.planLogTime({ date: '2026-10-08', start: '7pm', minutes: 30 })).rejects.toThrow(/time like 09:30/);
  });

  it('takes a local time by the offset of that time, on the day the clocks change too', async () => {
    const ny = new ClickUpWork(new ClickUp({ token: 'pk_test', workspaceId: '900', timeZone: 'America/New_York', fetch: fakeClickUp() }));
    const spring = await ny.planLogTime({ date: '2026-03-08', start: '09:00', minutes: 60 }); // clocks go forward at 02:00
    expect(spring.calls[0]!.body).toMatchObject({ start: Date.parse('2026-03-08T09:00:00-04:00') });
    expect(spring.details[0]!.value).toBe('2026-03-08 09:00 to 10:00 (1h 00m)');
    const fall = await ny.planLogTime({ date: '2026-11-01', start: '09:00', minutes: 60 }); // and back at 02:00
    expect(fall.calls[0]!.body).toMatchObject({ start: Date.parse('2026-11-01T09:00:00-05:00') });
    const due = await ny.planCreateTask({ listId: 'l1', name: 'x', due: '2026-03-08' });
    expect(due.calls[0]!.body).toMatchObject({ due_date: Date.parse('2026-03-08T04:00:00-04:00') });
  });

  it('writes Docs: a new Doc with its first page, a new page, a page changed', async () => {
    const calls: string[] = [];
    const w = work(calls, '900');
    expect(await w.perform(await w.planDoc({ name: 'Postmortem', content: '# What happened' }))).toMatchObject({ done: true, id: 'doc9' });
    const edit = await w.planDoc({ docId: 'doc1', pageId: 'p1', content: 'more', mode: 'append' });
    expect(edit).toMatchObject({ title: 'Change page "Deploy" of Doc "Runbook"', details: [{ label: 'Add at its end', value: 'more' }] });
    await w.perform(edit);
    expect(changes(calls)).toEqual([
      'POST /api/v3/workspaces/900/docs {"name":"Postmortem","create_page":false}',
      'POST /api/v3/workspaces/900/docs/doc9/pages {"name":"Postmortem","content":"# What happened","content_format":"text/md"}',
      'PUT /api/v3/workspaces/900/docs/doc1/pages/p1 {"content":"more","content_edit_mode":"append","content_format":"text/md"}',
    ]);
    expect((await w.planDoc({ docId: 'doc1', name: 'Notes', parentPageId: 'p1' })).calls[0]).toMatchObject({ path: '/api/v3/workspaces/900/docs/doc1/pages', body: { name: 'Notes', parent_page_id: 'p1' } });
    await expect(w.planDoc({ content: 'x' })).rejects.toThrow(/give name for a new Doc/);
    await expect(w.planDoc({ docId: 'doc1', pageId: 'p404', content: 'x' })).rejects.toThrow(/no page p404/);
    await expect(work().planDoc({ name: 'x' })).rejects.toThrow(/give workspace_id/);
  });
});
