import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type ClickUp, startOfDay } from './clickup.js';
import type { Config } from './config.js';
import type { Dispatcher } from './dispatcher.js';
import { createWorktreeChat, dropWorktrees } from './git-routes.js';
import { insideRoot } from './paths.js';
import type { Push } from './push.js';
import type { Store } from './store.js';
import { canAccess, SANDBOXES } from './util.js';

type Deps = { cfg: Config; store: Store; dispatcher: Dispatcher; push: Push; clickup?: () => ClickUp | undefined; clickupForAll?: () => boolean };

const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }] });
const fail = (m: string) => ({ isError: true, content: [{ type: 'text' as const, text: m }] });

// What an agent running inside a conversation may do. It runs in the Codex process, outside Codex's sandbox, so it
// gets no way to widen its own powers: no new projects or sandbox levels, no approvals, no deleting.
const AGENT_TOOLS = new Set([
  'list_projects', 'list_conversations', 'create_conversation', 'get_conversation', 'send_prompt',
  'list_queue', 'get_events', 'list_accounts', 'get_approval',
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

  s.registerTool('list_projects', { description: 'List registered projects.' }, async () => text(store.listProjects().filter(open)));

  s.registerTool('create_project', {
    description: 'Register an existing folder (inside the allowed workspace root) as a project.',
    inputSchema: { name: z.string().min(1), path: z.string().min(1), sandbox: z.enum(SANDBOXES).optional() },
  }, async ({ name, path, sandbox }) => {
    const real = insideRoot(cfg.workspaceRoot, path);
    if (!real) return fail('path must be an existing directory inside WORKSPACE_ROOT');
    return text(store.createProject(name, real, sandbox));
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
    return text({ deleted: true });
  });

  s.registerTool('list_conversations', {
    description: 'List the conversations of a project.', inputSchema: { project_id: z.string() },
  }, async ({ project_id }) => (getProject(project_id) ? text(store.listConversations(project_id)) : fail(`no such project: ${project_id}`)));

  s.registerTool('create_conversation', {
    description: 'Start a new conversation (a fresh agent session) in a project. With worktree, it works on its own git branch and folder.',
    inputSchema: { project_id: z.string(), worktree: z.boolean().optional() },
  }, async ({ project_id, worktree }) => {
    const project = getProject(project_id);
    if (!project) return fail(`no such project: ${project_id}`);
    if (!worktree) return text(store.createConversation(project_id));
    try { return text(await createWorktreeChat(store, cfg, project)); } catch (e) { return fail((e as Error).message); }
  });


  s.registerTool('get_conversation', {
    description: 'Get a conversation with its most recent turns.',
    inputSchema: { conversation_id: z.string(), turns_limit: z.number().int().min(1).max(100).optional() },
  }, async ({ conversation_id, turns_limit }) => {
    const c = conv(conversation_id);
    return c ? text({ ...c, turns: store.listTurns(c.id).slice(-(turns_limit ?? 10)) }) : noConv(conversation_id);
  });

  s.registerTool('send_prompt', {
    description: 'Queue a prompt for a conversation. A prompt sent from one conversation into another may need human approval.',
    inputSchema: { conversation_id: z.string(), prompt: z.string().min(1) },
  }, async ({ conversation_id, prompt }) => {
    if (!conv(conversation_id)) return noConv(conversation_id);
    if (source && source !== conversation_id && cfg.mcpCrossSend === 'approve') {
      const approvalId = store.createApproval(source, conversation_id, prompt, onBehalf);
      void push.notify({ title: 'Approval needed', body: `A chat wants to message another one: ${prompt.slice(0, 80)}`, convId: source });
      return text({ status: 'pending_approval', approval_id: approvalId });
    }
    const queueId = store.enqueue(conversation_id, prompt, [], '', onBehalf);
    dispatcher.kick(conversation_id);
    return text({ status: 'queued', queue_id: queueId });
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
    description: 'Read a conversation\'s events (agent messages, commands, errors) after an event id. Use next_after_id to continue.',
    inputSchema: { conversation_id: z.string(), after_id: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional() },
  }, async ({ conversation_id, after_id, limit }) => {
    if (!conv(conversation_id)) return noConv(conversation_id);
    const rows = store.eventsAfter(conversation_id, after_id ?? 0).slice(0, limit ?? 100);
    const events = rows.map((r) => {
      let data: unknown = null;
      try { data = JSON.parse(r.payload); } catch { /* keep null */ }
      return { id: r.id, type: r.type, data };
    });
    return text({ events, next_after_id: rows.length ? rows[rows.length - 1]!.id : (after_id ?? 0) });
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

  // An agent inside a conversation is restricted most; otherwise the caller's role decides.
  const hidden = source ? (name: string) => !AGENT_TOOLS.has(name) : role === 'dev' ? (name: string) => DEV_BLOCKED.has(name) : () => false;
  for (const [name, tool] of tools) if (hidden(name)) tool.remove();
  const cu = owner || d.clickupForAll?.() ? d.clickup?.() : undefined;
  if (cu) clickupTools(server, cu);
  return server;
}

const WORKSPACES = z.array(z.string()).optional()
  .describe('ClickUp workspace ids (from clickup_whoami); default: the one set in Settings, else every workspace');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-10-01');

/**
 * Read-only ClickUp Chat tools. They read with the owner's personal ClickUp token, so unless the owner marked them for
 * all users only the owner gets them: the main token or the owner's own sign-in from outside, and inside a chat only
 * during a turn the owner sent.
 */
function clickupTools(server: McpServer, cu: ClickUp): void {
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
