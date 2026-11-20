import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createClickUpApproval } from './clickup-approvals.js';
import { type ClickUp, MAX_FILES, type OutFile } from './clickup.js';
import { type ClickUpAction, ClickUpWork, MAX_WRITE, PRIORITIES } from './clickup-work.js';
import type { Push } from './push.js';
import type { Store } from './store.js';

const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }] });
const fail = (m: string) => ({ isError: true, content: [{ type: 'text' as const, text: m }] });

const WORKSPACES = z.array(z.string()).optional()
  .describe('ClickUp workspace ids (from clickup_whoami); default: the default in Settings, or the only workspace the API key can access');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-10-01');
const WHEN = z.string().regex(/^(\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?)?$/, 'a date like 2026-10-01 or 2026-10-01 14:30');
const TASK = z.string().min(1).describe('a task id, a custom id (DEV-42) or a https://app.clickup.com/t/... link');
const PEOPLE = z.array(z.string().min(1)).max(20).optional();
const CUSTOM = z.array(z.object({ id: z.string().min(1), value: z.any() })).max(20).optional()
  .describe('custom fields to set: id from clickup_get_list, value as that field type takes it (text, a number, an option id for a dropdown, epoch ms for a date)');
const FILES = z.array(z.string().min(1)).min(1).max(MAX_FILES);
const WAITS = ' Nothing changes at once: it waits for the person to approve it in Dalang (status pending_approval), '
  + 'who sees what it does; the outcome comes to this chat as a message, or ask clickup_send_status. Do not ask again while it waits.';

/** What an action does, in plain lines: kept as the approval's text, quoted back to the chat and shown by clickup_send_status. */
const inWords = (a: ClickUpAction) => [a.title, ...a.details.map((d) => `${d.label}: ${d.value.length > 500 ? `${d.value.slice(0, 500)}…` : d.value}`)].join('\n');

/**
 * ClickUp tools beyond chat: spaces and lists, tasks, time entries and Docs. They read as the same ClickUp user as the
 * chat tools. With sending allowed by the owner, changes can be asked for too; like messages, each waits for the
 * approval of the person it is made as.
 */
export function clickupWorkTools(
  server: McpServer, store: Store, push: Push, cu: ClickUp, send: boolean, by: { who: string; conv: string | null; user: string },
  /** Where an approval's files wait, and how the chat's files are read (paths in its folder). */
  files: { stateDir: string; read: (paths: string[]) => OutFile[] },
): void {
  const work = new ClickUpWork(cu);
  const run = async (f: () => Promise<unknown>) => { try { return text(await f()); } catch (e) { return fail((e as Error).message); } };

  server.registerTool('clickup_list_spaces', {
    description: 'The ClickUp tree: every space with its folders and lists (ids, names). '
      + 'Where tasks live: a list id is what clickup_find_tasks filters by and clickup_create_task creates in.',
    inputSchema: { workspace_ids: WORKSPACES, space_id: z.string().optional().describe('only this space') },
  }, async (a) => run(() => work.spaces(a.workspace_ids, a.space_id)));

  server.registerTool('clickup_get_list', {
    description: 'A ClickUp list: its space, the statuses its tasks can have and its custom fields (id, type, options). '
      + 'Read it before setting a status or a custom field.',
    inputSchema: { list_id: z.string().min(1).describe('from clickup_list_spaces') },
  }, async (a) => run(() => work.list(a.list_id)));

  server.registerTool('clickup_find_tasks', {
    description: 'Find ClickUp tasks, last changed first: id, name, status, assignees, due date, priority, list and link. '
      + 'Filter by list, space or folder, assignee ("me" is the ClickUp user), status, tag, due date or part of the name. '
      + 'Open tasks only, and no subtasks, unless asked.',
    inputSchema: {
      query: z.string().optional().describe('part of the name or custom id'),
      assignees: PEOPLE.describe('user ids (from clickup_find_people), or "me"'),
      list_ids: z.array(z.string()).optional().describe('from clickup_list_spaces'),
      space_ids: z.array(z.string()).optional(), folder_ids: z.array(z.string()).optional(),
      statuses: z.array(z.string()).optional().describe('status names as the list has them'),
      tags: z.array(z.string()).optional(),
      include_closed: z.boolean().optional().describe('also closed (done) tasks'),
      subtasks: z.boolean().optional().describe('also subtasks'),
      parent: z.string().optional().describe('the subtasks of this task instead (only query applies then)'),
      due_from: DATE.optional(), due_to: DATE.optional().describe('due between these local dates, both included'),
      updated_since: DATE.optional(), workspace_ids: WORKSPACES,
      limit: z.number().int().min(1).max(200).optional().describe('default 50'),
    },
  }, async (a) => run(() => work.findTasks({
    query: a.query, assignees: a.assignees, listIds: a.list_ids, spaceIds: a.space_ids, folderIds: a.folder_ids, statuses: a.statuses,
    tags: a.tags, includeClosed: a.include_closed, subtasks: a.subtasks, parent: a.parent, dueFrom: a.due_from, dueTo: a.due_to,
    updatedSince: a.updated_since, workspaceIds: a.workspace_ids, limit: a.limit,
  })));

  server.registerTool('clickup_get_task', {
    description: 'One ClickUp task in full: description (markdown), status, assignees, dates, priority, tags, custom fields, '
      + 'checklists and their items (read only), subtasks, tasks it waits on, blocks or is linked to, attachments, time estimated and '
      + 'spent. With comments=true also its comments.',
    inputSchema: {
      task: TASK, comments: z.boolean().optional(),
      comment_limit: z.number().int().min(1).max(500).optional().describe('how many of the latest comments (default 50); comments_more says older ones are left'),
    },
  }, async (a) => run(() => work.task(a.task, a.comments, a.comment_limit)));

  server.registerTool('clickup_time_entries', {
    description: 'Time tracked in ClickUp between two local dates (both included, at most 93 days): each entry with local '
      + 'date, weekday, start and end time, minutes, task and description, plus the total of each day and of the range. '
      + "The ClickUp user's own entries unless assignees names others (ClickUp shows those to workspace owners and admins only).",
    inputSchema: {
      from: DATE, to: DATE, workspace_ids: WORKSPACES, assignees: PEOPLE.describe('user ids (from clickup_find_people), or "me"; default: me'),
      task: TASK.optional().describe('only time on this task'),
    },
  }, async (a) => run(() => work.timeEntries({ from: a.from, to: a.to, workspaceIds: a.workspace_ids, assignees: a.assignees, task: a.task })));

  server.registerTool('clickup_list_docs', {
    description: 'ClickUp Docs of the workspaces that its search finds (id, name, link, last change), optionally for query: words of the name or the text.',
    inputSchema: { query: z.string().optional(),
      search_in: z.enum(['name', 'name_and_content']).optional().describe('Use name for title searches via the API. Searching page contents requires ClickUp MCP.'),
      workspace_ids: WORKSPACES, limit: z.number().int().min(1).max(200).optional().describe('default 50') },
  }, async (a) => run(() => work.docs(a.workspace_ids, a.query, a.limit, a.search_in)));

  server.registerTool('clickup_get_doc', {
    description: 'A ClickUp Doc: its pages as a tree of ids and names (a Doc of a single page comes with its text); with '
      + 'page_id, the text of that page as markdown.',
    inputSchema: {
      doc_id: z.string().min(1).describe('from clickup_list_docs, or the id in a Doc link (…/docs/<id> or …/v/dc/<id>)'), page_id: z.string().optional(),
      workspace_id: z.string().optional().describe("the Doc's workspace; default: looked up"),
    },
  }, async (a) => run(() => work.doc(a.doc_id, a.page_id, a.workspace_id)));

  if (!send) return;
  /** Holds a planned change for the person's approval, with the files (read now) that go to `task` when it is made. */
  const ask = (plan: (sent: OutFile[]) => Promise<ClickUpAction>, paths: string[] = [], taskRef?: string) => run(async () => {
    const sent = paths.length ? files.read(paths) : [];
    const action = await plan(sent);
    const task = sent.length ? await cu.task(taskRef!) : undefined;
    const p = createClickUpApproval(store, { user: by.user, clickupUserId: (await cu.user()).id, action, content: inWords(action), who: by.who, conv: by.conv, files: sent, task, stateDir: files.stateDir });
    void push.notify({ title: 'ClickUp change needs approval', body: action.title.slice(0, 140), convId: by.conv ?? '', audience: { user: by.user } });
    return {
      status: 'pending_approval', approval_id: p.id, change: p.content,
      note: 'Nothing was changed yet: the person approves it in Dalang. The outcome will arrive in this chat as a message; do not ask again.',
    };
  });
  const FIELDS = {
    description: z.string().max(MAX_WRITE).optional().describe('markdown'),
    status: z.string().optional().describe('as the list has it (clickup_get_list)'),
    priority: z.enum(PRIORITIES).optional(),
    time_estimate_minutes: z.number().int().min(0).max(600_000).optional(),
    custom_fields: CUSTOM,
  };
  const notes = (sent: OutFile[]) => sent.map((f) => ({ name: f.name, size: f.data.length }));
  const custom = (list?: { id: string; value?: unknown }[]) => list?.map((c) => ({ id: c.id, value: c.value ?? null }));

  server.registerTool('clickup_create_task', {
    description: 'Ask to create a ClickUp task (or, with parent, a subtask) in a list, as the ClickUp user from '
      + 'clickup_whoami. Settle the list with the person first unless they named it (clickup_list_spaces).' + WAITS,
    inputSchema: {
      list_id: z.string().min(1).describe('from clickup_list_spaces'), name: z.string().min(1).max(500), ...FIELDS,
      assignees: PEOPLE.describe('user ids (from clickup_find_people), or "me"'), tags: z.array(z.string().min(1)).max(20).optional(),
      due: WHEN.optional().describe('local date, or date and time: 2026-10-01 or 2026-10-01 14:30'), start: WHEN.optional(),
      parent: TASK.optional().describe('makes it a subtask of this task (of the same list)'),
    },
  }, async (a) => ask(() => work.planCreateTask({
    listId: a.list_id, name: a.name, description: a.description, status: a.status, priority: a.priority, due: a.due, start: a.start,
    timeEstimateMinutes: a.time_estimate_minutes, parent: a.parent, assignees: a.assignees, tags: a.tags, customFields: custom(a.custom_fields),
  })));

  server.registerTool('clickup_update_task', {
    description: 'Ask to change a ClickUp task: its name, description, status, priority, dates, assignees, tags, custom '
      + 'fields, parent or list (move_to_list; with a status when the new list lacks the one it has). Only what you name '
      + 'changes. Tasks are never deleted or archived through these tools.' + WAITS,
    inputSchema: {
      task: TASK, name: z.string().min(1).max(500).optional(), ...FIELDS,
      due: WHEN.optional().describe('local date, or date and time; "" takes the due date away'), start: WHEN.optional().describe('"" takes it away'),
      add_assignees: PEOPLE.describe('user ids, or "me"'), remove_assignees: PEOPLE,
      add_tags: z.array(z.string().min(1)).max(20).optional(), remove_tags: z.array(z.string().min(1)).max(20).optional(),
      parent: TASK.optional().describe('move it under this task'), move_to_list: z.string().optional().describe('a list id: its new home list'),
    },
  }, async (a) => ask(() => work.planUpdateTask({
    task: a.task, name: a.name, description: a.description, status: a.status, priority: a.priority, due: a.due, start: a.start,
    timeEstimateMinutes: a.time_estimate_minutes, parent: a.parent, customFields: custom(a.custom_fields), addAssignees: a.add_assignees,
    removeAssignees: a.remove_assignees, addTags: a.add_tags, removeTags: a.remove_tags, moveToList: a.move_to_list,
  })));

  server.registerTool('clickup_comment_task', {
    description: 'Ask to comment on a ClickUp task (markdown) as the ClickUp user, or to reply to one of its comments (reply_to). '
      + 'Show the person the text first and post only what they agreed to. Files (files, paths in this chat folder; '
      + 'images too) are attached to the task when the comment is posted, and the comment ends with a line naming each.' + WAITS,
    inputSchema: {
      task: TASK, text: z.string().min(1).max(MAX_WRITE),
      reply_to: z.string().optional().describe('a comment id (from clickup_get_task with comments) to reply to'),
      assignee: z.string().optional().describe('assign the comment to this user id, or "me"'),
      notify_all: z.boolean().optional().describe('notify everyone on the task, the ClickUp user included'),
      files: FILES.optional().describe(`files to attach and name: paths in this chat's folder, at most ${MAX_FILES} of 25 MB each`),
    },
  }, async (a) => ask((sent) => work.planComment({
    task: a.task, text: a.text, replyTo: a.reply_to, assignee: a.assignee, notifyAll: a.notify_all, files: notes(sent),
  }), a.files, a.task));

  server.registerTool('clickup_attach_file', {
    description: 'Ask to attach files from this chat folder to a ClickUp task, with no comment (to say something with '
      + 'them, use clickup_comment_task with files instead).' + WAITS,
    inputSchema: { task: TASK, files: FILES.describe(`paths in this chat's folder, at most ${MAX_FILES} of 25 MB each`) },
  }, async (a) => ask((sent) => work.planAttach({ task: a.task, files: notes(sent) }), a.files, a.task));

  server.registerTool('clickup_link_tasks', {
    description: 'Ask to tie two ClickUp tasks: task waits on other (waits_on), task blocks other (blocks), or they are '
      + 'merely linked (link); remove=true takes that tie away.' + WAITS,
    inputSchema: { task: TASK, other: TASK, kind: z.enum(['waits_on', 'blocks', 'link']), remove: z.boolean().optional() },
  }, async (a) => ask(() => work.planLink(a)));

  server.registerTool('clickup_log_time', {
    description: 'Ask to log time worked on a ClickUp task, as the ClickUp user.' + WAITS,
    inputSchema: {
      task: TASK, date: DATE, start: z.string().regex(/^\d{2}:\d{2}$/, 'a time like 09:30').describe('local time it began'),
      minutes: z.number().int().min(1).max(24 * 60), description: z.string().max(2000).optional(), billable: z.boolean().optional(),
    },
  }, async (a) => ask(() => work.planLogTime(a)));

  server.registerTool('clickup_write_doc', {
    description: 'Ask to write in ClickUp Docs (markdown): a new Doc (name; content becomes its first page; private to the ClickUp '
      + 'user unless visibility is public), a new page '
      + 'of a Doc (doc_id, name, content), or a page changed (doc_id, page_id: content replaces its text, or with mode is '
      + 'added at its end or start; name renames it). Read the page first (clickup_get_doc) before replacing it.' + WAITS,
    inputSchema: {
      doc_id: z.string().optional().describe('from clickup_list_docs; none creates a Doc'), page_id: z.string().optional().describe('from clickup_get_doc'),
      name: z.string().max(300).optional(), content: z.string().max(5 * MAX_WRITE).optional(),
      mode: z.enum(['replace', 'append', 'prepend']).optional().describe('default replace'),
      parent_page_id: z.string().optional().describe('a new page goes under this one'),
      workspace_id: z.string().optional().describe('for a new Doc in another workspace than the default'),
      visibility: z.enum(['private', 'public']).optional().describe('of a new Doc: private (default), or public for everyone in the workspace'),
    },
  }, async (a) => ask(() => work.planDoc({
    docId: a.doc_id, pageId: a.page_id, name: a.name, content: a.content, mode: a.mode, parentPageId: a.parent_page_id, workspaceId: a.workspace_id, visibility: a.visibility,
  })));
}
