import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type ClickUpApproval, createClickUpApproval, describeDestination, readClickUpApprovals } from './clickup-approvals.js';
import { type ClickUp, MAX_SEND, type OutFile, startOfDay } from './clickup.js';
import { type CodeMemory, shapeOf } from './code-memory.js';
import type { Config } from './config.js';
import { BACKUP_MAX_ROWS, backupWrite, createDbApproval, type DbBackup, type DbLogEntry, dbTarget, describeBackup, logDbQuery, readDbApprovals } from './database-routes.js';
import {
  agentRefusal, describeUnsafe, findUnsafe, type DbConnection, listDatabases, loadConnections, multiDatabase, onDatabase, QueryError, readSchema, runScript,
} from './databases.js';
import type { Dispatcher } from './dispatcher.js';
import { createWorktreeChat, dropWorktrees } from './git-routes.js';
import { cleanMemory, MEMORY_MAX, queryTerms, searchTerms } from './memory.js';
import { EFFORTS, modelTier, refuseChoice, runOf } from './model-ceiling.js';
import { insideRoot } from './paths.js';
import type { Push } from './push.js';
import { reviewTools } from './review-tools.js';
import { createSshApproval, findDangerous, loadHosts, logSsh, readSshApprovals, runCommand, type SshHost, targetOf } from './ssh-hosts.js';
import { compactPayload, CUT } from './event-view.js';
import type { Conversation, Memory, MemoryScope, Project, Store, StoredEvent } from './store.js';
import { BACKENDS, type Backend, canAccess, SANDBOXES } from './util.js';

type Deps = {
  cfg: Config; store: Store; dispatcher: Dispatcher; push: Push; clickup?: () => ClickUp | undefined; clickupForAll?: () => boolean;
  clickupSend?: () => boolean; codeMemory?: CodeMemory;
};

const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }] });
const fail = (m: string) => ({ isError: true, content: [{ type: 'text' as const, text: m }] });

// Starts with a letter/digit so the value can never be read as a CLI flag (as in the REST API).
const MODEL = z.string().regex(/^([A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,63})?$/, 'a model slug');
const EFFORT = z.enum(['', ...EFFORTS]);

// What an agent running inside a conversation may do. It runs in the Codex process, outside Codex's sandbox, so it
// gets no way to widen its own powers: no new projects or sandbox levels, no approvals, no deleting.
const AGENT_TOOLS = new Set([
  'list_projects', 'list_conversations', 'create_conversation', 'get_conversation', 'send_prompt',
  'list_queue', 'get_events', 'list_accounts', 'get_approval', 'list_models', 'set_model',
  'memory_search', 'memory_save', 'memory_update', 'memory_forget',
]);

// A dev user connecting from outside gets the everyday tools only: no new projects, no unblocking
// accounts (the same things the REST API keeps for admins).
const DEV_BLOCKED = new Set(['create_project', 'delete_project', 'unblock_accounts']);

/**
 * `source` is the conversation the calling agent runs in, taken from its per-turn token (never from a header it
 * could forge), or null for an outside client holding the main token. Only a send from one conversation into a
 * different one counts as "cross-conversation" and may need approval. `onBehalf`: the panel user the caller works for
 * (an agent: whoever sent its turn's prompt), so a prompt it sends runs with that user's git setup, not the server's.
 */
type Viewer = { id: string | null; role: 'admin' | 'dev' | null };

/** `viewer`: whose project access applies (see canAccess); an agent may always reach its own chat's project. */
function buildServer(d: Deps, source: string | null, role: 'admin' | 'dev', owner: boolean, viewer: Viewer, onBehalf = ''): McpServer {
  const { cfg, store, dispatcher, push } = d;
  const server = new McpServer({ name: 'dalang', version: '0.1.0' });
  const tools = new Map<string, { remove(): void }>();
  const s = {
    registerTool: (name: string, config: unknown, cb: (args: any) => Promise<unknown>) => {
      tools.set(name, server.registerTool(name, config as any, cb as any));
    },
  };
  const ownProject = source ? store.getConversation(source)?.project_id : undefined;
  const open = (p: { id: string; access: string }) => p.id === ownProject || canAccess(viewer, p.access);
  // A project, or a chat in one, that the viewer may not open is reported as not existing.
  const getProject = (id: string) => { const p = store.getProject(id); return p && open(p) ? p : null; };
  const conv = (id: string | null | undefined) => {
    const c = id ? store.getConversation(id) : null;
    return c && getProject(c.project_id) ? c : null;
  };
  const noConv = (id: string) => fail(`no such conversation: ${id}`);
  // The calling agent's own model and effort: the most it may give a chat (see refuseChoice).
  const cap = () => { const own = source ? store.getConversation(source) : null; return own ? runOf(store, own) : null; };
  /**
   * Queue `prompt` in `c`. An agent's prompt into another chat waits for a person, except into its own sub-agents in
   * the same project (unless an admin turned that off), which run it at once and report back (see Dispatcher).
   */
  const deliver = (c: Conversation, prompt: string) => {
    const own = source !== null && c.parent === source && c.project_id === ownProject && store.getSubagentPolicy().autoSend;
    if (source && source !== c.id && !own && cfg.mcpCrossSend === 'approve') {
      const approvalId = store.createApproval(source, c.id, prompt, onBehalf);
      void push.notify({ title: 'Approval needed', body: `A chat wants to message another one: ${prompt.slice(0, 80)}`, convId: source, audience: { admin: true, conversation: c.id } });
      return { status: 'pending_approval' as const, approval_id: approvalId };
    }
    const queueId = store.enqueue(c.id, prompt, [], '', onBehalf, source && source !== c.id ? source : '');
    dispatcher.kick(c.id);
    return { status: 'queued' as const, queue_id: queueId };
  };
  // What the chat's next turn runs with.
  const withEffective = (c: Conversation) => { const r = runOf(store, c); return { ...c, effective_model: r.model, effective_effort: r.effort }; };

  s.registerTool('list_projects', { description: 'List registered projects.' }, async () => text(store.listProjects().filter(open)));

  s.registerTool('create_project', {
    description: 'Register an existing folder (inside the allowed workspace root) as a project.',
    inputSchema: { name: z.string().min(1), path: z.string().min(1), sandbox: z.enum(SANDBOXES).optional() },
  }, async ({ name, path, sandbox }) => {
    const real = insideRoot(cfg.workspaceRoot, path);
    if (!real) return fail('path must be an existing directory inside WORKSPACE_ROOT');
    const created = store.createProject(name, real, sandbox);
    return text(created);
  });

  s.registerTool('delete_project', {
    description: 'Remove a project and its conversations from the gateway (files on disk are untouched).',
    inputSchema: { project_id: z.string() },
  }, async ({ project_id }) => {
    const project = getProject(project_id);
    if (!project) return fail(`no such project: ${project_id}`);
    const convs = store.listConversations(project_id);
    for (const c of convs) dispatcher.cancel(c.id);
    store.deleteProject(project_id);
    void dropWorktrees(dispatcher, project, convs);
    void d.codeMemory?.forget(project);
    return text({ deleted: true });
  });

  s.registerTool('list_conversations', {
    description: 'List the conversations of a project.', inputSchema: { project_id: z.string() },
  }, async ({ project_id }) => (getProject(project_id) ? text(store.listConversations(project_id)) : fail(`no such project: ${project_id}`)));

  s.registerTool('create_conversation', {
    description: 'Start a new conversation (a fresh agent session) in a project. From inside a chat it becomes your sub-agent: '
      + 'you decide how many to start, for what, and with which model; give prompt to start its task at once (see send_prompt: '
      + 'its answer comes back to you as a message). With worktree, it works on its own git branch and folder, so parallel '
      + 'sub-agents do not write over each other. model, effort and backend choose what runs it (default: the project\'s backend '
      + 'and the default model; from inside a chat, your own model and effort). It never runs above yours: see list_models. '
      + 'Pick the weakest model that fits the task, and move it up with set_model only if its work falls short. '
      + 'Before your first sub-agent in a chat, read the orchestrating-subagents skill (SKILL.md in the skills list) and follow it.',
    inputSchema: {
      project_id: z.string(), worktree: z.boolean().optional(),
      backend: z.enum(BACKENDS).optional(), model: MODEL.optional(), effort: EFFORT.optional(),
      prompt: z.string().min(1).optional().describe('the first task for it, sent right after it is created'),
    },
  }, async ({ project_id, worktree, backend, model, effort, prompt }) => {
    const project = getProject(project_id);
    if (!project) return fail(`no such project: ${project_id}`);
    const ceiling = cap();
    const b = backend ?? project.backend;
    // Left out, a sub-agent runs on the parent's effort, and on the parent's model when it is on the same CLI.
    const inherit = { model: ceiling && b === ceiling.backend ? ceiling.model : null, effort: ceiling?.effort ?? null };
    // An effort the child's model does not take (max on Codex, xhigh on a small model) comes down to the highest it does.
    if (!effort && inherit.effort) inherit.effort = await dispatcher.fitEffort(b, model || inherit.model || null, inherit.effort);
    const want = { backend: b, model: model || inherit.model || store.getDefaultModel(b) || null, effort: effort || inherit.effort || store.getDefaultEffort(b) || null };
    const why = refuseChoice(want, ceiling);
    if (why) return fail(why);
    if (source) {
      const policy = store.getSubagentPolicy();
      if (!policy.maxChildren || !policy.maxDepth) return fail('an admin has turned sub-agents off');
      if (store.depthOf(source) + 1 > policy.maxDepth) {
        return fail(`sub-agents may go ${policy.maxDepth} level(s) deep and this chat is at the limit: do this part yourself`);
      }
      if (store.countChildren(source) >= policy.maxChildren) {
        return fail(`this chat already has ${policy.maxChildren} sub-agents, the most allowed: give one of them the work (send_prompt), or ask a person to delete one`);
      }
    }
    let c: Conversation;
    try {
      c = worktree ? await createWorktreeChat(store, cfg, project, { backend, parent: source ?? '' }) : store.createConversation(project_id, backend, source ?? '');
    } catch (e) { return fail((e as Error).message); }
    if (model || inherit.model) store.setModel(c.id, model || inherit.model!);
    if (effort || inherit.effort) store.setEffort(c.id, effort || inherit.effort!);
    const created = withEffective(store.getConversation(c.id)!);
    return text(prompt ? { ...created, prompt: deliver(created, prompt) } : created);
  });

  s.registerTool('set_model', {
    description: 'Change the model and/or reasoning effort of a conversation, from its next turn on (its session carries on). '
      + 'An agent may change its own conversation and the ones it created, never above its own model and effort (see list_models); '
      + '\'\' goes back to the default. '
      + 'Move one step up at a time, when a result falls short (failing tests, unfinished or wrong work), not by default.',
    inputSchema: {
      conversation_id: z.string(), model: MODEL.optional(), effort: EFFORT.optional(),
      backend: z.enum(BACKENDS).optional().describe('move it to another agent CLI: a new session, told the chat so far; '
        + 'its model and effort go back to that CLI\'s defaults unless given. Not while a turn runs in it'),
    },
  }, async ({ conversation_id, model, effort, backend }) => {
    const c = conv(conversation_id);
    if (!c) return noConv(conversation_id);
    if (source && c.id !== source && c.parent !== source) return fail('an agent may only change its own conversation and the ones it created');
    if (model === undefined && effort === undefined && backend === undefined) return fail('give model, effort, backend or a mix');
    const moving = backend !== undefined && backend !== c.backend;
    if (moving && dispatcher.isRunning(c.id)) return fail('a turn is running in that conversation: change its backend once it is done');
    // A move to another CLI drops the model and effort it had (see Store.setBackend).
    const next = { backend: backend ?? c.backend, model: model ?? (moving ? '' : c.model), effort: effort ?? (moving ? '' : c.effort) };
    const why = refuseChoice(runOf(store, next), cap());
    if (why) return fail(why);
    if (moving) store.setBackend(c.id, backend);
    if (model !== undefined) store.setModel(c.id, model);
    if (effort !== undefined) store.setEffort(c.id, effort);
    return text(withEffective(store.getConversation(c.id)!));
  });

  s.registerTool('list_models', {
    description: 'The models and reasoning efforts a conversation on this backend can run with, weakest first, the defaults, '
      + 'and (for an agent) which of them you may pick with create_conversation and set_model: none above your own.',
    inputSchema: { backend: z.enum(BACKENDS).optional().describe('default: your conversation\'s backend, else codex') },
  }, async ({ backend }) => {
    const b = backend ?? (source ? store.getConversation(source)?.backend : undefined) ?? 'codex';
    const known = await dispatcher.models(b);
    const defaults = { default_model: store.getDefaultModel(b) || null, default_effort: store.getDefaultEffort(b) || null };
    const own = cap();
    if (!own) return text({ backend: b, ...defaults, models: known });
    const top = own.model ? modelTier(own.model) : null;
    const allowed = known.filter((m) => m.slug === own.model || (top !== null && (modelTier(m.slug) ?? Infinity) <= top))
      .map((m) => ({ rank: modelTier(m.slug) ?? top ?? 0, ...m }))
      .sort((x, y) => x.rank - y.rank);
    return text({
      backend: b, ...defaults, your_model: own.model, your_effort: own.effort,
      models: allowed,
      efforts: own.effort ? EFFORTS.slice(0, EFFORTS.indexOf(own.effort as never) + 1) : [EFFORTS[0]],
      note: top !== null
        ? 'Ranked weakest (0) to strongest, none above your own model. Start low; go one rank up only when the work falls short.'
        : 'Your own model cannot be ranked: leave model out and sub-agents run on yours.',
    });
  });

  s.registerTool('get_conversation', {
    description: 'Get a conversation with its most recent turns.',
    inputSchema: { conversation_id: z.string(), turns_limit: z.number().int().min(1).max(100).optional() },
  }, async ({ conversation_id, turns_limit }) => {
    const c = conv(conversation_id);
    return c ? text({ ...withEffective(c), turns: store.listTurns(c.id).slice(-(turns_limit ?? 10)) }) : noConv(conversation_id);
  });

  s.registerTool('send_prompt', {
    description: 'Queue a prompt for a conversation. Your own sub-agents (conversations you created in this project) take it '
      + 'straight away and their answer comes back to you as a message when they are done, so do not poll for it. '
      + 'A prompt into any other conversation may need human approval.',
    inputSchema: { conversation_id: z.string(), prompt: z.string().min(1) },
  }, async ({ conversation_id, prompt }) => {
    const c = conv(conversation_id);
    return c ? text(deliver(c, prompt)) : noConv(conversation_id);
  });

  s.registerTool('list_queue', {
    description: 'List prompts waiting behind the running turn.', inputSchema: { conversation_id: z.string() },
  }, async ({ conversation_id }) => (conv(conversation_id) ? text(store.listQueue(conversation_id)) : noConv(conversation_id)));

  s.registerTool('remove_queue_item', {
    description: 'Remove a queued prompt.', inputSchema: { queue_id: z.number().int() },
  }, async ({ queue_id }) => (conv(store.queueConversation(queue_id)) && store.deleteQueueItem(queue_id) ? text({ removed: true }) : fail(`no such queue item: ${queue_id}`)));

  s.registerTool('cancel_turn', {
    description: 'Stop the turn that is currently running in a conversation.', inputSchema: { conversation_id: z.string() },
  }, async ({ conversation_id }) => (conv(conversation_id) ? text({ cancelled: dispatcher.cancel(conversation_id) }) : noConv(conversation_id)));

  s.registerTool('set_draft', {
    description: 'Save the unsent draft text of a conversation.', inputSchema: { conversation_id: z.string(), draft: z.string() },
  }, async ({ conversation_id, draft }) => {
    if (!conv(conversation_id)) return noConv(conversation_id);
    store.setDraft(conversation_id, draft);
    return text({ saved: true });
  });

  s.registerTool('get_events', {
    description: 'Read a conversation\'s events (prompts, agent messages, commands, file changes, errors), oldest first. '
      + `By default long tool output (command output, diffs, thoughts over ${CUT} characters) is cut and marked "cut": true, `
      + 'and item.updated events are left out; read one cut event in full with after_id = its id - 1, limit 1, full true. '
      + 'Either after an event id (after_id, limit; next_after_id continues), or by turns: last_turns gives the last turns '
      + '(before turn before_turn when given; earlier_before_turn pages further back while more_earlier is true). '
      + 'messages_only returns prompts and agent messages, excluding tools and other events to save context.',
    inputSchema: {
      conversation_id: z.string(), after_id: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional(),
      full: z.boolean().optional(), last_turns: z.number().int().min(1).max(50).optional(), before_turn: z.number().int().min(1).optional(),
      messages_only: z.boolean().optional(),
    },
  }, async ({ conversation_id, after_id, limit, full, last_turns, before_turn, messages_only }) => {
    if (!conv(conversation_id)) return noConv(conversation_id);
    // Every event's text goes into the caller's context: cut what it rarely needs, and no indentation.
    const shape = (rows: StoredEvent[]) => {
      const events = [];
      for (const r of rows) {
        if (messages_only && r.type !== 'user.prompt' && r.type !== 'item.completed') continue;
        const payload = full ? r.payload : compactPayload(r.type, r.payload);
        if (payload === null) continue;
        let data: unknown = null;
        try { data = JSON.parse(payload); } catch { /* keep null */ }
        if (messages_only && r.type !== 'user.prompt'
          && (data as { item?: { type?: string } } | null)?.item?.type !== 'agent_message') continue;
        events.push({ id: r.id, type: r.type, data });
      }
      return events;
    };
    const plain = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });
    if (last_turns) {
      const page = store.historyPage(conversation_id, { turns: last_turns, before: before_turn });
      const lastId = page.events.length ? page.events[page.events.length - 1]!.id : 0;
      return plain({ events: shape(page.events), next_after_id: lastId, earlier_before_turn: page.first, more_earlier: page.more });
    }
    // Read on past left-out events until `limit` are in (or none are left).
    const want = limit ?? 100;
    const events: ReturnType<typeof shape> = [];
    let next = after_id ?? 0;
    for (;;) {
      const rows = store.eventsAfter(conversation_id, next, want);
      if (!rows.length) break;
      for (const r of rows) {
        const [e] = shape([r]);
        next = r.id;
        if (e) events.push(e);
        if (events.length === want) break;
      }
      if (events.length === want || rows.length < want) break;
    }
    return plain({ events, next_after_id: next });
  });

  s.registerTool('list_accounts', { description: 'List Codex accounts and whether each is at its usage limit.' }, async () => text(dispatcher.accounts.list()));

  s.registerTool('unblock_accounts', { description: 'Clear the usage-limit block on every account.' }, async () => {
    dispatcher.accounts.unblockAll();
    return text({ unblocked: true });
  });

  s.registerTool('get_approval', {
    description: 'Check whether a held cross-conversation send was approved. Only a human can approve or reject.',
    inputSchema: { approval_id: z.number().int() },
  }, async ({ approval_id }) => {
    const a = store.getApproval(approval_id);
    return a && conv(a.to_conv) ? text(a) : fail(`no such approval: ${approval_id}`);
  });

  // Memory (see memory.ts): facts kept for every later chat of a project, and the preferences of the person the caller
  // works for (scope "mine"), apart from the chats themselves. A person's own are theirs alone.
  const PROJECT = ownProject ? z.string().optional().describe("another project you may open (default: this chat's project)") : z.string().optional();
  const SCOPE = z.enum(['project', 'mine']).optional()
    .describe("project (default): the project's facts; mine: the preferences of the person you work for, in any project");
  const me = store.userKeyOf(onBehalf);
  /** The scope asked for, or why there is none. */
  const memoryScope = (scope: 'project' | 'mine' | undefined, projectId: string | undefined): MemoryScope | string => {
    if (scope === 'mine') return me ? { userKey: me } : 'no person to keep this for: this turn was not sent by one';
    const p = getProject(projectId || ownProject || '');
    return p ? { projectId: p.id } : `no such project: ${projectId ?? ''}`;
  };
  const memoryOf = (id: number) => {
    const m = store.getMemory(id);
    return m && (m.project_id ? getProject(m.project_id) : me && m.user_key === me) ? m : null;
  };
  const brief = (m: Memory) =>
    ({ id: m.id, scope: m.project_id ? 'project' : 'mine', text: m.text, from_chat: m.source_title || null, updated_at: m.updated_at });

  s.registerTool('memory_search', {
    description: 'Search the memory: facts kept from earlier chats of a project (decisions, conventions, how things are built '
      + 'and run), or with scope "mine" the preferences of the person you work for. Those with every word of query come '
      + 'first; when none has them all, the best partial matches. Without query, the newest first.',
    inputSchema: { project_id: PROJECT, scope: SCOPE, query: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).optional() },
  }, async ({ project_id, scope, query, limit }) => {
    const sc = memoryScope(scope, project_id);
    if (typeof sc === 'string') return fail(sc);
    // Every word first; with none like that, those that match some of them, best first.
    const all = store.searchMemories(sc, searchTerms(query));
    const found = all.length || !query ? all : store.matchMemories(sc, queryTerms(query), limit ?? 50);
    return text(found.slice(0, limit ?? 50).map(brief));
  });

  s.registerTool('memory_save', {
    description: 'Keep a fact for later chats (it stays when this chat is deleted): by default in the project memory, for every '
      + 'later chat of the project; with scope "mine", a preference the person you work for gave about how to work with '
      + `them, for their turns in any project (only they see it). One self-contained sentence, at most ${MEMORY_MAX} `
      + 'characters. Only what a later chat must not miss; never secrets.',
    inputSchema: { project_id: PROJECT, scope: SCOPE, text: z.string().min(1).max(2000) },
  }, async ({ project_id, scope, text: t }) => {
    const sc = memoryScope(scope, project_id);
    if (typeof sc === 'string') return fail(sc);
    const clean = cleanMemory(t);
    if (!clean) return fail('give the fact to keep');
    const from = source ? store.getConversation(source) : null;
    return text(brief(store.addMemory(sc, clean, { conv: source ?? '', title: from?.title ?? '', by: source ? 'agent' : onBehalf })));
  });

  s.registerTool('memory_update', {
    description: 'Rewrite a memory (by its id) that is out of date or wrong.',
    inputSchema: { id: z.number().int(), text: z.string().min(1).max(2000) },
  }, async ({ id, text: t }) => {
    const m = memoryOf(id);
    if (!m) return fail(`no such memory: ${id}`);
    const clean = cleanMemory(t);
    if (!clean) return fail('give the new text');
    store.updateMemory(m.id, clean);
    return text(brief(store.getMemory(m.id)!));
  });

  s.registerTool('memory_forget', {
    description: 'Remove a memory (by its id) that is wrong or no longer matters.',
    inputSchema: { id: z.number().int() },
  }, async ({ id }) => {
    const m = memoryOf(id);
    if (!m) return fail(`no such memory: ${id}`);
    store.deleteMemory(m.id);
    return text({ removed: true });
  });

  // An agent inside a conversation is restricted most; otherwise the caller's role decides.
  const hidden = source ? (name: string) => !AGENT_TOOLS.has(name) : role === 'dev' ? (name: string) => DEV_BLOCKED.has(name) : () => false;
  for (const [name, tool] of tools) if (hidden(name)) tool.remove();
  const cu = owner || d.clickupForAll?.() ? d.clickup?.() : undefined;
  if (cu) clickupTools(server, store, push, cfg.stateDir, cu, d.clickupSend?.() ?? false, { who: onBehalf, conv: source });
  // Every MCP caller counts as an agent here: it gets the connections marked for agents that its viewer may open.
  const dbs = loadConnections(store).filter((c) => c.agent !== 'off' && canAccess(viewer, c.access));
  if (dbs.length) databaseTools(server, store, push, cfg.stateDir, dbs, { who: onBehalf, conv: source });
  const hosts = loadHosts(store).filter((h) => h.agent !== 'off' && canAccess(viewer, h.access));
  if (hosts.length) sshTools(server, store, push, hosts, { who: onBehalf, conv: source });
  if (d.codeMemory?.active) codeTools(server, d.codeMemory, ownProject, getProject);
  reviewTools(server, store, source);
  return server;
}

/**
 * Code memory: CBM's query tools as code_<name>, on the graph of the caller's own chat project or of another project it
 * may open (never one it may not: CBM is asked for that project's graph only).
 */
function codeTools(server: McpServer, cm: CodeMemory, own: string | undefined, getProject: (id: string) => Project | null): void {
  for (const t of cm.tools()) {
    server.registerTool(`code_${t.name}`, {
      description: `Code memory: ${t.description ?? t.name}`,
      inputSchema: {
        ...shapeOf(t.inputSchema, ['project']),
        project_id: own ? z.string().optional().describe("another project you may open (default: this chat's project)") : z.string(),
      },
    }, async ({ project_id, ...args }: Record<string, unknown>) => {
      const id = (project_id as string | undefined) || own;
      const project = id ? getProject(id) : null;
      if (!project) return fail(`no such project: ${id ?? ''}`);
      try { return await cm.query(project, t.name, args); } catch (e) { return fail((e as Error).message); }
    });
  }
}

const WORKSPACES = z.array(z.string()).optional()
  .describe('ClickUp workspace ids (from clickup_whoami); default: the one set in Settings, else every workspace');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-10-01');

/**
 * ClickUp Chat tools. They use the owner's personal ClickUp token, so unless the owner marked them for all users only
 * the owner gets them: the main token or the owner's own sign-in from outside, and inside a chat only during a turn the
 * owner sent. They only read, unless the owner also allowed sending: clickup_send_message then asks to send as the
 * owner, and each message waits for the owner's approval.
 */
const MAX_FILES = 5;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Files an agent sends along, read now from its chat's folder (paths relative to it): each once, at most 5 of 25 MB. */
function readChatFiles(store: Store, conv: string | null, paths: string[]): OutFile[] {
  const c = conv ? store.getConversation(conv) : null;
  const project = c && store.getProject(c.project_id);
  if (!c || !project) throw new Error('files can be sent only from inside a chat, from its folder');
  const root = c.worktree ?? project.path;
  const out: OutFile[] = [];
  for (const p of paths) {
    const real = insideRoot(root, p);
    if (!real || !statSync(real).isFile()) throw new Error(`no file ${p} in this chat's folder`);
    if (statSync(real).size > MAX_FILE_BYTES) throw new Error(`${p} is over 25 MB`);
    const name = basename(real);
    if (out.some((f) => f.name === name)) throw new Error(`two files are named ${name}`);
    out.push({ name, data: readFileSync(real) });
  }
  return out;
}

function clickupTools(server: McpServer, store: Store, push: Push, stateDir: string, cu: ClickUp, send: boolean, by: { who: string; conv: string | null }): void {
  const run = async (f: () => Promise<unknown>) => { try { return text(await f()); } catch (e) { return fail((e as Error).message); } };

  server.registerTool('clickup_whoami', {
    description: 'The ClickUp user the ClickUp tools read as, every workspace it can see (and which one is read by default), and the time zone dates are given in.',
  }, async () => run(() => cu.whoami()));

  server.registerTool('clickup_list_channels', {
    description: 'List ClickUp Chat channels, DMs and group DMs (id, name, type, workspace). With since, only those with a message since that date.',
    inputSchema: { since: DATE.optional(), workspace_ids: WORKSPACES },
  }, async ({ since, workspace_ids }) => run(async () => cu.channels(since ? startOfDay(since, await cu.timeZone()) : undefined, workspace_ids)));

  server.registerTool('clickup_chat_history', {
    description: 'Read ClickUp Chat messages (channels, DMs and group DMs) between two local dates (both included, at most 93 days), '
      + 'oldest first, each with local date, time, weekday, workspace, channel and author. By default only messages the ClickUp '
      + 'user wrote; mine_only=false shows the conversation around them.',
    inputSchema: {
      from: DATE, to: DATE, workspace_ids: WORKSPACES,
      channel_ids: z.array(z.string()).optional().describe('only these channels (ids from clickup_list_channels)'),
      mine_only: z.boolean().optional().describe('default true'),
      include_replies: z.boolean().optional().describe('also read thread replies (slower, more requests)'),
      limit: z.number().int().min(1).max(1000).optional().describe('max messages listed, default 300'),
    },
  }, async (a) => run(() => cu.history({
    from: a.from, to: a.to, workspaceIds: a.workspace_ids, channelIds: a.channel_ids, mineOnly: a.mine_only,
    includeReplies: a.include_replies, limit: a.limit,
  })));

  server.registerTool('clickup_list_threads', {
    description: 'The latest top-level messages of a ClickUp Chat channel or DM, newest first (id, local date and time, '
      + 'author, how many replies, the start of the text), to pick one whose thread to reply in.',
    inputSchema: {
      channel_id: z.string().min(1).describe('from clickup_list_channels'),
      workspace_id: z.string().optional().describe("the channel's workspace; default: looked up"),
      limit: z.number().int().min(1).max(100).optional().describe('default 20'),
    },
  }, async (a) => run(() => cu.threads(a.channel_id, a.workspace_id, a.limit)));

  server.registerTool('clickup_find_people', {
    description: 'People in the ClickUp workspaces (id, name, email, workspace), but the ClickUp user itself, whose name or '
      + 'email contains query: whom to send a direct message to.',
    inputSchema: { query: z.string().optional().describe('part of a name or email; empty lists everyone'), workspace_ids: WORKSPACES },
  }, async (a) => run(() => cu.people(a.query, a.workspace_ids)));

  if (!send) return;
  server.registerTool('clickup_send_message', {
    description: 'Ask to send a ClickUp Chat message (markdown) as the ClickUp user from clickup_whoami: to a channel, DM '
      + 'or group DM (channel_id), as a reply in the thread of one of its messages (channel_id and reply_to), or privately '
      + 'to a person (to_user_id; their DM is opened). Before calling, settle with the person where it goes: unless they '
      + 'named it plainly, show the choices and let them pick: the channel (clickup_list_channels), then whether to post '
      + 'in it or reply in a thread and which one (clickup_list_threads), or, for a private message, the person '
      + '(clickup_find_people). Then show the text and send only what they agreed to. Nothing is sent at once: the '
      + 'message waits for the owner to approve it in Dalang (status pending_approval), who may change the text; the '
      + 'outcome comes to this chat as a message, or ask clickup_send_status. Do not ask again while it waits. Files '
      + '(files, paths in this chat folder) cannot go into ClickUp Chat itself: they are uploaded to a ClickUp task '
      + '(task_id, an id or link the person gives you; ask which one) when the message is sent, and the message ends with '
      + 'a link to each, which whoever may open the task can follow.',
    inputSchema: {
      channel_id: z.string().optional().describe('from clickup_list_channels'),
      to_user_id: z.string().optional().describe('instead of channel_id: a person from clickup_find_people'),
      reply_to: z.string().optional().describe('with channel_id: a message id (from clickup_list_threads) to reply to in its thread'),
      content: z.string().min(1).max(MAX_SEND),
      workspace_id: z.string().optional().describe("the channel's or person's workspace; default: looked up"),
      files: z.array(z.string().min(1)).max(MAX_FILES).optional()
        .describe(`files to send along: paths in this chat's folder, at most ${MAX_FILES} of 25 MB each (needs task_id)`),
      task_id: z.string().optional().describe('with files: the ClickUp task (id or https://app.clickup.com/t/... link) they are uploaded to'),
    },
  }, async (a) => run(async () => {
    if (!a.content.trim()) throw new Error('the message is empty');
    if (a.files?.length && !a.task_id) throw new Error('files need task_id: ClickUp Chat takes no files over its API, so they go to a task and the message links them');
    const files = a.files?.length ? readChatFiles(store, by.conv, a.files) : [];
    const dest = await cu.destination({ channelId: a.channel_id, toUserId: a.to_user_id, replyTo: a.reply_to, workspaceId: a.workspace_id });
    const task = files.length ? await cu.task(a.task_id!) : undefined;
    const p = createClickUpApproval(store, { dest, content: a.content.trim(), who: by.who, conv: by.conv, files, task, stateDir });
    void push.notify({ title: 'ClickUp message needs approval', body: `${describeDestination(dest)}: ${p.content.replace(/\s+/g, ' ').slice(0, 100)}`, convId: by.conv ?? '', audience: { owner: true } });
    return {
      status: 'pending_approval', approval_id: p.id, to: dest, ...(task && { files: p.files, task }),
      note: 'Nothing was sent yet: the owner approves it in Dalang. The outcome will arrive in this chat as a message; do not send it again.',
    };
  }));

  server.registerTool('clickup_send_status', {
    description: 'The status of a ClickUp message asked for with clickup_send_message: pending, sending, sent, rejected, '
      + 'failed, unknown (sending was cut off) or dismissed, with the text as sent. Never ask again for a sending, sent or unknown one.',
    inputSchema: { approval_id: z.number().int() },
  }, async ({ approval_id }) => {
    // Only the one who asked: the same chat, or from outside a chat the same panel user.
    const mine = (x: ClickUpApproval) => (by.conv ? x.conv === by.conv : x.conv === null && x.who === by.who);
    const a = readClickUpApprovals(store).find((x) => x.id === approval_id && mine(x));
    return a ? text(a) : fail(`no such approval: ${approval_id}`);
  });
}

const AGENT_DB_TIMEOUT_MS = 30_000;

/**
 * The SQL editor's connections that are open to agents (in /sql: "Agent access"). A read-only one runs every statement
 * in a read-only transaction or session, enforced by the database; on an 'approve' one a script the database refuses
 * that way waits for an admin instead. Statements that reach past the tables are refused for agents in every mode.
 * Each query goes into the connection's log.
 */
function databaseTools(server: McpServer, store: Store, push: Push, stateDir: string, dbs: DbConnection[], by: { who: string; conv: string | null }): void {
  const get = (id: string) => dbs.find((c) => c.id === id);
  const readOnly = (c: DbConnection) => c.readOnly || c.agent !== 'read-write';
  const mode = (c: DbConnection) => (c.readOnly || c.agent === 'read-only' ? 'read-only' : c.agent === 'approve' ? 'read, write after approval' : 'read-write');
  const none = (id: string) => fail(`no such connection: ${id} (see db_list_connections)`);
  const DATABASE = z.string().optional()
    .describe('another database on the same server, for a connection that lists several (default: its own)');

  server.registerTool('db_list_connections', {
    description: 'List the database connections you may query: id, engine, its database (or, for a PostgreSQL connection '
      + 'that opens several, every database you may pass as database) and whether you may only read.',
  }, async () => text(await Promise.all(dbs.map(async (c) => ({
    id: c.id, label: c.label, engine: c.driver, database: c.driver === 'sqlite' ? c.file : c.database || (multiDatabase(c) ? 'postgres' : ''),
    ...(multiDatabase(c) && { databases: await listDatabases(c).catch((e: Error) => `could not list them: ${e.message}`) }),
    access: mode(c),
  })))));

  server.registerTool('db_schema', {
    description: 'Tables and views of a connection with their columns (name, type, nullable, primary key). Narrow it with schema or table on a big database.',
    inputSchema: {
      connection: z.string(), database: DATABASE, schema: z.string().optional().describe('only this schema'),
      table: z.string().optional().describe('only tables whose name contains this'),
    },
  }, async ({ connection, database, schema, table }) => {
    const c = get(connection);
    if (!c) return none(connection);
    try {
      const target = onDatabase(c, database);
      const info = await readSchema(target, AGENT_DB_TIMEOUT_MS, schema);
      let schemas = info.schemas.filter((s) => !schema || s.name === schema)
        .map((s) => ({ ...s, tables: s.tables.filter((t) => !table || t.name.toLowerCase().includes(table.toLowerCase())) }))
        .filter((s) => s.tables.length);
      // A big database comes without columns: read them for the few schemas a table filter narrowed it to.
      if (table && schemas.length <= 5 && schemas.some((s) => !s.loaded)) {
        schemas = await Promise.all(schemas.map(async (s) => (s.loaded ? s : {
          ...s, tables: (await readSchema(target, AGENT_DB_TIMEOUT_MS, s.name)).schemas[0]?.tables
            .filter((t) => t.name.toLowerCase().includes(table.toLowerCase())) ?? [],
        })));
      }
      const count = schemas.reduce((n, s) => n + s.tables.length, 0);
      // A large answer lists only names; asking again with a schema or table gives the columns.
      if (count > 150) return text({ note: `${count} tables: names only. Pass schema or table for their columns.`, schemas: schemas.map((s) => ({ name: s.name, tables: s.tables.map((t) => t.name) })) });
      return text({ schemas: schemas.map((s) => ({ name: s.name, tables: s.tables.map((t) => ({
        name: t.name, kind: t.kind, columns: t.columns.map((col) => `${col.name} ${col.type}${col.pk ? ' PK' : ''}${col.nullable ? '' : ' NOT NULL'}`),
      })) })) });
    } catch (e) { return fail((e as Error).message); }
  });

  server.registerTool('db_query', {
    description: 'Run SQL on a connection: one statement or several separated by ;. MongoDB connections take mongosh-style '
      + 'commands instead (db.users.find({ age: { $gt: 30 } }).sort({ name: 1 }), aggregate, countDocuments, distinct, insertOne, '
      + 'updateMany, ...; pass database), Redis ones Redis commands, one per line (HGETALL user:1, SCAN 0 MATCH user:*; pass database '
      + 'as db0..db15). Elasticsearch connections take one JSON search body with optional index, '
      + 'for example {"index":"books","query":{"match_all":{}}}; searches only, no writes. Returns the columns and rows of each statement '
      + '(at most limit rows per statement). On a read-only connection anything that writes is refused by the database. On a '
      + '"write after approval" one, a script that writes is held for an admin instead (status pending_approval): the outcome '
      + 'comes to this chat as a message, or ask db_approval. Before a write runs, the rows its UPDATE, DELETE, TRUNCATE and DROP TABLE '
      + `statements (MongoDB: updates, deletes, drops) are about to change are backed up (at most ${BACKUP_MAX_ROWS} rows); if that `
      + 'backup fails, nothing runs.',
    inputSchema: {
      connection: z.string(), database: DATABASE, sql: z.string().min(1).max(100_000),
      limit: z.number().int().min(1).max(1000).optional().describe('max rows per statement, default 100'),
    },
  }, async ({ connection, database, sql, limit }) => {
    const c = get(connection);
    if (!c) return none(connection);
    const t0 = Date.now();
    const log = (ok: boolean, rows: number, error?: string, extra: Partial<DbLogEntry> = {}) =>
      logDbQuery(store, c.id, {
        at: t0, who: by.who, conv: by.conv, ...(database && { database }), sql: sql.slice(0, 4000), ok, rows, ms: Date.now() - t0, ...(error && { error }), ...extra,
      });
    const refused = agentRefusal(sql, c.driver, readOnly(c));
    if (refused) { log(false, 0, refused); return fail(refused); }
    // Writing freely, an agent may not hit every row of a table by leaving out the WHERE (with approval, the card says it).
    const unsafe = c.agent === 'read-write' && !c.readOnly ? findUnsafe(sql, c.driver) : [];
    if (unsafe.length) {
      const msg = `refused: ${unsafe.map(describeUnsafe).join('; ')} would change every row. Add a WHERE (WHERE true if every row is really meant), `
        + 'or ask a human to run it in the SQL editor.';
      log(false, 0, msg);
      return fail(msg);
    }
    // Writing freely: what the script is about to change is kept first, and nothing runs if that fails.
    let backup: DbBackup | null = null;
    if (!readOnly(c)) {
      try {
        backup = await backupWrite(stateDir, onDatabase(c, database), { ...(database && { database }), sql, who: by.who, conv: by.conv });
      } catch (e) {
        const msg = `refused: the backup of what this changes failed, so nothing ran: ${(e as Error).message}. Narrow the write, or ask a human to run it in the SQL editor.`;
        log(false, 0, msg);
        return fail(msg);
      }
    }
    const kept = backup?.file ? { backup: backup.file, backupRows: backup.rows } : {};
    let requestedTarget: string | undefined;
    try {
      // Keep the target used by the probe even if its saved connection changes while it runs.
      requestedTarget = dbTarget(c, database);
      const results = await runScript(onDatabase(c, database), sql, { readOnly: readOnly(c), limit: limit ?? 100, timeoutMs: AGENT_DB_TIMEOUT_MS, maxCell: 2000 });
      log(true, results.reduce((n, r) => n + r.rows.length, 0), undefined, kept);
      return text({
        results: results.map((r) => ({ columns: r.columns.map((col) => col.name), rows: r.rows, affected: r.affected, truncated: r.truncated })),
        ...(backup && { backup: describeBackup(backup) }),
      });
    } catch (e) {
      // A write on a "write after approval" connection: the whole script waits for an admin (it ran read-only, so
      // nothing of it was kept).
      if (requestedTarget && e instanceof QueryError && e.readOnlyRefusal && c.agent === 'approve' && !c.readOnly) {
        const flagged = findUnsafe(sql, c.driver).map(describeUnsafe);
        const a = createDbApproval(store, { conn: c.id, target: requestedTarget, ...(database && { database }), sql, who: by.who, conv: by.conv, ...(flagged.length && { unsafe: flagged }) });
        log(false, 0, `held for approval #${a.id}`);
        void push.notify({ title: 'Database write needs approval', body: `${c.label}: ${sql.replace(/\s+/g, ' ').slice(0, 100)}`, convId: by.conv ?? '', audience: { admin: true, database: c.id } });
        return text({
          status: 'pending_approval', approval_id: a.id,
          note: 'This script writes, so it waits for an admin. Nothing of it ran. The outcome will arrive in this chat as a message; do not send it again.',
        });
      }
      const done = e instanceof QueryError ? e.results.length : 0;
      log(false, 0, (e as Error).message, kept);
      return fail(`${done ? `statement ${done + 1} failed (the ${done} before it ran): ` : ''}${(e as Error).message}${backup ? `\n${describeBackup(backup)}` : ''}`);
    }
  });

  if (!dbs.some((c) => c.agent === 'approve')) return;
  server.registerTool('db_approval', {
    description: 'The status and outcome of a database write held for approval: pending, executing, approved, rejected, failed, unknown after an interrupted execution, or dismissed by an admin. Dismissal closes an unknown request without confirming its outcome. Never retry an executing, unknown or dismissed request; an admin must check its effects first.',
    inputSchema: { approval_id: z.number().int() },
  }, async ({ approval_id }) => {
    const a = readDbApprovals(store).find((x) => x.id === approval_id && get(x.conn));
    if (!a) return fail(`no such approval: ${approval_id}`);
    return text({ id: a.id, connection: a.conn, database: a.database, status: a.status, outcome: a.outcome ?? null, decided_by: a.decidedBy ?? null });
  });
}

const SSH_TIMEOUT_DEFAULT_S = 60;
const SSH_TIMEOUT_MAX_S = 600;

/**
 * SSH hosts (the SSH Hosts page) open to agents: shell commands run with a login Dalang keeps. The agent sees each host's name,
 * label and note only, never its address, user or secrets (which are also taken out of what a command prints). On an
 * 'approve' host every command waits for an admin; on a 'run' one, those that read as dangerous. Each command goes into
 * the host's log.
 */
function sshTools(server: McpServer, store: Store, push: Push, hosts: SshHost[], by: { who: string; conv: string | null }): void {
  const get = (id: string) => hosts.find((h) => h.id === id);
  server.registerTool('ssh_list_hosts', {
    description: 'List the SSH hosts (servers, VMs) you may run shell commands on with ssh_exec: id, label, what it is, '
      + "whether each command waits for an admin's approval, and whether sudo can be used. Dalang keeps the logins; you never get them.",
  }, async () => text(hosts.map((h) => ({
    id: h.id, label: h.label, ...(h.note && { note: h.note }), access: h.agent === 'approve' ? 'every command after approval' : 'run (dangerous commands after approval)',
    sudo: h.sudoPassword || h.auth === 'password' ? 'yes (Dalang answers its password)' : 'only if sudo needs no password there',
  }))));

  server.registerTool('ssh_exec', {
    description: 'Run a shell command on an SSH host (see ssh_list_hosts) in a fresh session, as the user Dalang logs in with. '
      + 'No terminal and nothing on standard input: interactive programs (editors, prompts, pagers, password questions) hang '
      + 'until the timeout, so pass flags like -y or --no-pager. Each call is a new session: cd and variables do not carry '
      + 'over, chain with && instead. Returns the exit code, stdout and stderr (the start and end of long output). sudo: true '
      + 'runs it as root through sudo, whose password Dalang gives. On a host that needs approval the command is held for an '
      + 'admin (status pending_approval), and so is a dangerous one (deleting files, stopping services, rebooting, changing '
      + 'users or the firewall, removing packages or containers, piping into a shell, ...) on any host: the outcome comes '
      + 'to this chat as a message, or ask ssh_approval. Keep commands plain and to the point so they need no approval.',
    inputSchema: {
      host: z.string(), command: z.string().min(1).max(20_000),
      sudo: z.boolean().optional().describe('run it as root through sudo'),
      timeout_seconds: z.number().int().min(1).max(SSH_TIMEOUT_MAX_S).optional().describe(`default ${SSH_TIMEOUT_DEFAULT_S}`),
    },
  }, async ({ host, command, sudo, timeout_seconds }) => {
    const h = get(host);
    if (!h) return fail(`no such host: ${host} (see ssh_list_hosts)`);
    const timeoutMs = (timeout_seconds ?? SSH_TIMEOUT_DEFAULT_S) * 1000;
    const t0 = Date.now();
    const entry = { at: t0, who: by.who, conv: by.conv, command: command.slice(0, 4000), ...(sudo && { sudo: true }) };
    const dangerous = h.agent === 'run' ? findDangerous(command, h.holdPatterns) : [];
    if (h.agent === 'approve' || dangerous.length) {
      const a = createSshApproval(store, {
        host: h.id, target: targetOf(h), command, sudo: !!sudo, timeoutMs, who: by.who, conv: by.conv, ...(dangerous.length && { dangerous }),
      });
      logSsh(store, h.id, { ...entry, ok: false, ms: 0, error: `held for approval #${a.id}` });
      void push.notify({ title: 'SSH command needs approval', body: `${h.label}: ${command.replace(/\s+/g, ' ').slice(0, 100)}`, convId: by.conv ?? '', audience: { admin: true, host: h.id } });
      return text({
        status: 'pending_approval', approval_id: a.id,
        ...(dangerous.length && { held_because: dangerous }),
        note: `${dangerous.length ? 'This command looks dangerous, so it waits for an admin' : 'Commands on this host wait for an admin'}. Nothing ran yet. `
          + 'The outcome will arrive in this chat as a message; do not send it again.',
      });
    }
    try {
      const r = await runCommand(h, command, { sudo, timeoutMs });
      logSsh(store, h.id, { ...entry, ok: true, exitCode: r.exitCode, ms: r.ms });
      return text({
        exit_code: r.exitCode, ...(r.signal && { signal: r.signal }), ...(r.timedOut && { timed_out: true }), stdout: r.stdout, stderr: r.stderr,
        ...(r.truncated && { truncated: true }),
      });
    } catch (e) {
      const msg = (e as Error).message;
      logSsh(store, h.id, { ...entry, ok: false, ms: Date.now() - t0, error: msg });
      return fail(msg);
    }
  });

  server.registerTool('ssh_approval', {
    description: 'The status and outcome of an SSH command held for approval: pending, executing, approved, rejected, failed, unknown after an interrupted execution, or dismissed by an admin. Dismissal closes an unknown request without confirming its outcome. Never retry an executing, unknown or dismissed request; an admin must check its effects first.',
    inputSchema: { approval_id: z.number().int() },
  }, async ({ approval_id }) => {
    const a = readSshApprovals(store).find((x) => x.id === approval_id && get(x.host));
    if (!a) return fail(`no such approval: ${approval_id}`);
    return text({ id: a.id, host: a.host, status: a.status, outcome: a.outcome ?? null, decided_by: a.decidedBy ?? null });
  });
}

/** Stateless Streamable HTTP MCP endpoint: every POST gets its own server+transport and answers with plain JSON. */
export function mcpRoutes(app: FastifyInstance, d: Deps): void {
  app.post('/mcp', async (req, reply) => {
    const owner = req.mcpConv ? req.mcpAuthor === 'owner' : req.user?.id === null;
    const onBehalf = req.mcpConv ? req.mcpAuthor ?? '' : req.user?.name ?? '';
    // An agent sees the projects of the user whose prompt it runs; with none (an approval, another agent), the 'all' ones.
    const author = req.mcpConv && !owner ? d.store.listUsers().find((u) => u.name === req.mcpAuthor) : undefined;
    const viewer: Viewer = !req.mcpConv ? { id: req.user?.id ?? null, role: req.user?.role ?? 'admin' }
      : owner ? { id: null, role: 'admin' } : { id: author?.id ?? '', role: author?.role ?? null };
    const server = buildServer(d, req.mcpConv ?? null, req.user?.role ?? 'admin', owner, viewer, onBehalf);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const notAllowed = (_req: unknown, reply: any) =>
    reply.code(405).header('allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
