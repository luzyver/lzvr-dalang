import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Dispatcher } from './dispatcher.js';
import { insideRoot } from './paths.js';
import type { Push } from './push.js';
import { listSessions } from './sessions.js';
import type { Store } from './store.js';
import { DEFAULT_AUTOPILOT_PROMPT, SANDBOXES, UUID_RE } from './util.js';

type Deps = { cfg: Config; store: Store; dispatcher: Dispatcher; push: Push };

const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }] });
const fail = (m: string) => ({ isError: true, content: [{ type: 'text' as const, text: m }] });

// What an agent running inside a conversation may do. It runs in the Codex process, outside Codex's sandbox, so it
// gets no way to widen its own powers: no new projects or sandbox levels, no autopilot, no approvals, no deleting.
const AGENT_TOOLS = new Set([
  'list_projects', 'list_conversations', 'create_conversation', 'get_conversation', 'send_prompt',
  'list_queue', 'get_events', 'list_accounts', 'get_approval',
]);

// A dev user connecting from outside gets the everyday tools only: no new projects, no adopting sessions,
// no autopilot, no unblocking accounts (the same things the REST API keeps for admins).
const DEV_BLOCKED = new Set(['create_project', 'delete_project', 'adopt_session', 'list_sessions', 'set_autopilot', 'unblock_accounts']);

/**
 * `source` is the conversation the calling agent runs in, taken from its per-turn token (never from a header it
 * could forge), or null for an outside client holding the main token. Only a send from one conversation into a
 * different one counts as "cross-conversation" and may need approval.
 */
function buildServer(d: Deps, source: string | null, role: 'admin' | 'dev'): McpServer {
  const { cfg, store, dispatcher, push } = d;
  const server = new McpServer({ name: 'dalang', version: '0.1.0' });
  const tools = new Map<string, { remove(): void }>();
  const s = {
    registerTool: (name: string, config: unknown, cb: (args: any) => Promise<unknown>) => {
      tools.set(name, server.registerTool(name, config as any, cb as any));
    },
  };
  const conv = (id: string) => store.getConversation(id);
  const noConv = (id: string) => fail(`no such conversation: ${id}`);

  s.registerTool('list_projects', { description: 'List registered projects.' }, async () => text(store.listProjects()));

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
    for (const c of store.listConversations(project_id)) dispatcher.cancel(c.id);
    return store.deleteProject(project_id) ? text({ deleted: true }) : fail(`no such project: ${project_id}`);
  });

  s.registerTool('list_conversations', {
    description: 'List the conversations of a project.', inputSchema: { project_id: z.string() },
  }, async ({ project_id }) => (store.getProject(project_id) ? text(store.listConversations(project_id)) : fail(`no such project: ${project_id}`)));

  s.registerTool('create_conversation', {
    description: 'Start a new conversation (a fresh Codex session) in a project.', inputSchema: { project_id: z.string() },
  }, async ({ project_id }) => (store.getProject(project_id) ? text(store.createConversation(project_id)) : fail(`no such project: ${project_id}`)));

  s.registerTool('list_sessions', {
    description: 'List Codex sessions found on this machine that can be adopted.', inputSchema: { limit: z.number().int().min(1).max(500).optional() },
  }, async ({ limit }) => {
    const home = dispatcher.accounts.primary();
    return text(home ? listSessions(home, limit ?? 100) : []);
  });

  s.registerTool('adopt_session', {
    description: 'Create a conversation that continues an existing Codex session (by its UUID).',
    inputSchema: { project_id: z.string(), thread_id: z.string() },
  }, async ({ project_id, thread_id }) => {
    if (!store.getProject(project_id)) return fail(`no such project: ${project_id}`);
    if (!UUID_RE.test(thread_id)) return fail('thread_id must be a session UUID');
    return text(store.createConversation(project_id, thread_id));
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
      const approvalId = store.createApproval(source, conversation_id, prompt);
      void push.notify({ title: 'Approval needed', body: `A chat wants to message another one: ${prompt.slice(0, 80)}`, convId: source });
      return text({ status: 'pending_approval', approval_id: approvalId });
    }
    const queueId = store.enqueue(conversation_id, prompt, []);
    dispatcher.kick(conversation_id);
    return text({ status: 'queued', queue_id: queueId });
  });

  s.registerTool('list_queue', {
    description: 'List prompts waiting behind the running turn.', inputSchema: { conversation_id: z.string() },
  }, async ({ conversation_id }) => (conv(conversation_id) ? text(store.listQueue(conversation_id)) : noConv(conversation_id)));

  s.registerTool('remove_queue_item', {
    description: 'Remove a queued prompt.', inputSchema: { queue_id: z.number().int() },
  }, async ({ queue_id }) => (store.deleteQueueItem(queue_id) ? text({ removed: true }) : fail(`no such queue item: ${queue_id}`)));

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

  s.registerTool('set_autopilot', {
    description: 'Turn autopilot on or off: keep sending continuation prompts until the agent says AUTOPILOT_DONE or max_turns is used.',
    inputSchema: { conversation_id: z.string(), enabled: z.boolean(), max_turns: z.number().int().min(1).max(100).optional(), prompt: z.string().min(1).optional() },
  }, async ({ conversation_id, enabled, max_turns, prompt }) => {
    if (!conv(conversation_id)) return noConv(conversation_id);
    store.setAutopilot(conversation_id, enabled, enabled ? (max_turns ?? 20) : 0, prompt ?? DEFAULT_AUTOPILOT_PROMPT);
    if (enabled) dispatcher.startAutopilot(conversation_id);
    return text({ enabled });
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
    return a ? text(a) : fail(`no such approval: ${approval_id}`);
  });

  // An agent inside a conversation is restricted most; otherwise the caller's role decides.
  const hidden = source ? (name: string) => !AGENT_TOOLS.has(name) : role === 'dev' ? (name: string) => DEV_BLOCKED.has(name) : () => false;
  for (const [name, tool] of tools) if (hidden(name)) tool.remove();
  return server;
}

/** Stateless Streamable HTTP MCP endpoint: every POST gets its own server+transport and answers with plain JSON. */
export function mcpRoutes(app: FastifyInstance, d: Deps): void {
  app.post('/mcp', async (req, reply) => {
    const server = buildServer(d, req.mcpConv ?? null, req.user?.role ?? 'admin');
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
