/**
 * The SSH Hosts page: the servers agents may run commands on through the gateway's ssh_* MCP tools (see ssh-hosts.ts).
 * Admins add and change them and decide the commands held for approval. Passwords, keys and passphrases never go back
 * to the panel.
 */
import type { FastifyInstance } from 'fastify';
import type { Dispatcher } from './dispatcher.js';
import {
  clearSshLog, describeRun, loadHosts, logSsh, readSshApprovals, readSshLog, runCommand, saveHosts, SSH_AGENT_MODES, type SshApproval, type SshHost,
  testHost, updateSshApproval,
} from './ssh-hosts.js';
import { keyProblem } from './ssh-tunnel.js';
import type { Store } from './store.js';
import { type AuthUser, canAccess, PROJECT_ACCESS } from './util.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** What the panel sees of a host: everything but its secrets, and whether each is set. */
export const viewHost = ({ password, privateKey, passphrase, sudoPassword, ...h }: SshHost) => ({
  ...h, hasPassword: !!password, hasKey: !!privateKey, hasPassphrase: !!passphrase, hasSudoPassword: !!sudoPassword,
});

interface Body {
  label: string; host: string; port?: number; user: string; auth: 'password' | 'key'; note?: string;
  access: SshHost['access']; agent: SshHost['agent'];
  /** Omitted keeps the saved one, '' removes it. */
  password?: string; privateKey?: string; passphrase?: string; sudoPassword?: string;
  /** The key Test connection showed. */
  hostKey?: string;
  /** More commands a 'run' host holds for approval: regular expressions. */
  holdPatterns?: string[];
}
const BODY = {
  type: 'object', required: ['label', 'host', 'user', 'auth', 'access', 'agent'], additionalProperties: false,
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 80 }, host: { type: 'string', minLength: 1, maxLength: 255 },
    port: { type: 'integer', minimum: 0, maximum: 65535 }, user: { type: 'string', minLength: 1, maxLength: 255 },
    auth: { enum: ['password', 'key'] }, note: { type: 'string', maxLength: 1000 },
    access: { enum: [...PROJECT_ACCESS] }, agent: { enum: [...SSH_AGENT_MODES] },
    password: { type: 'string', maxLength: 1000 }, privateKey: { type: 'string', maxLength: 20_000 },
    passphrase: { type: 'string', maxLength: 1000 }, sudoPassword: { type: 'string', maxLength: 1000 },
    hostKey: { type: 'string', maxLength: 200 },
    holdPatterns: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 500 } },
  },
};

const PANEL_TIMEOUT_MAX_MS = 600_000;

export function sshRoutes(app: FastifyInstance, d: { store: Store; dispatcher: Dispatcher }): void {
  const { store } = d;
  const requireAdmin = async (req: { user?: AuthUser }, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ error: 'admin only' });
  };
  /** The host, if this admin may open it (one they may not does not exist for them). */
  const find = (user: AuthUser, id: string) => loadHosts(store).find((h) => h.id === id && canAccess(user, h.access));

  /** A host from the form, or an error message. `old` gives the saved secrets when none are sent. */
  const build = (id: string, b: Body, user: AuthUser, old?: SshHost): SshHost | string => {
    if (b.access === 'owner' && user.id !== null) return 'only the owner can make a host owner-only';
    const host = b.host.trim();
    const port = b.port || 22;
    // The saved secrets go only to the server they were saved for: another address or user must be given them again
    // (an admin could otherwise point a host at a server of their own and read its password there).
    const same = !!old && old.host === host && old.port === port && old.user === b.user.trim();
    const keep = (sent: string | undefined, was: string | undefined) => (sent === undefined ? (same ? was ?? '' : '') : sent);
    const privateKey = b.privateKey === undefined ? keep(undefined, old?.privateKey) : b.privateKey.trim() ? `${b.privateKey.trim()}\n` : '';
    const h: SshHost = {
      id, label: b.label.trim(), host, port, user: b.user.trim(), auth: b.auth, note: b.note?.trim() ?? '',
      password: keep(b.password, old?.password), privateKey, passphrase: keep(b.passphrase, old?.passphrase),
      sudoPassword: keep(b.sudoPassword, old?.sudoPassword),
      // A key trusted for one server says nothing about another: a new address starts untrusted.
      hostKey: b.hostKey ?? (old && old.host === host && old.port === port ? old.hostKey : ''),
      access: b.access, agent: b.agent,
      holdPatterns: (b.holdPatterns ?? old?.holdPatterns ?? []).map((p) => p.trim()).filter(Boolean),
    };
    for (const p of h.holdPatterns!) {
      try { new RegExp(p, 'i'); } catch (e) { return `pattern ${p}: ${(e as Error).message}`; }
    }
    if (!h.host || !h.user) return 'a host and a user are needed';
    const again = old && !same ? ' (the address or user changed, so the saved one is not used: give it again)' : '';
    if (h.auth === 'key') {
      if (!h.privateKey) return `a private key is needed${again}`;
      const bad = keyProblem(h.privateKey, h.passphrase);
      if (bad) return `the private key cannot be read: ${bad}`;
    } else if (!h.password) return `a password is needed${again}`;
    return h;
  };

  app.get('/api/ssh/hosts', { onRequest: requireAdmin }, (req) => loadHosts(store).filter((h) => canAccess(req.user!, h.access)).map(viewHost));

  app.put<{ Params: { id: string }; Body: Body }>('/api/ssh/hosts/:id', { onRequest: requireAdmin, schema: { body: BODY } }, (req, reply) => {
    const { id } = req.params;
    if (!ID.test(id)) return reply.code(400).send({ error: 'name: lowercase letters, digits, - and _ (at most 32)' });
    const list = loadHosts(store);
    const old = list.find((h) => h.id === id);
    if (old && !canAccess(req.user!, old.access)) return reply.code(409).send({ error: `${id} is taken` });
    const next = build(id, req.body, req.user!, old);
    if (typeof next === 'string') return reply.code(400).send({ error: next });
    saveHosts(store, old ? list.map((h) => (h === old ? next : h)) : [...list, next]);
    return viewHost(next);
  });

  app.delete<{ Params: { id: string } }>('/api/ssh/hosts/:id', { onRequest: requireAdmin }, (req, reply) => {
    if (!find(req.user!, req.params.id)) return reply.code(404).send({ error: 'not found' });
    saveHosts(store, loadHosts(store).filter((h) => h.id !== req.params.id));
    clearSshLog(store, req.params.id);
    return reply.code(204).send();
  });

  // Tries a host as the form has it (a saved one's secrets are used when the form leaves them empty), trusting its key.
  app.post<{ Body: Body & { id?: string } }>('/api/ssh/test', {
    onRequest: requireAdmin, schema: { body: { ...BODY, properties: { ...BODY.properties, id: { type: 'string', maxLength: 32 } } } },
  }, async (req, reply) => {
    const { id, hostKey: _ignored, ...b } = req.body;
    const old = id ? find(req.user!, id) : undefined;
    const h = build(id || 'test', { ...b, hostKey: '' }, req.user!, old);
    if (typeof h === 'string') return reply.code(400).send({ error: h });
    try { return await testHost(h); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.get<{ Params: { id: string } }>('/api/ssh/hosts/:id/log', { onRequest: requireAdmin }, (req, reply) => {
    if (!find(req.user!, req.params.id)) return reply.code(404).send({ error: 'not found' });
    return readSshLog(store, req.params.id);
  });

  // Commands agents asked for on 'approve' hosts. Admins see those of hosts they may open.
  const visible = (user: AuthUser, a: SshApproval) => !!find(user, a.host);
  app.get<{ Querystring: { status?: string } }>('/api/ssh/approvals', { onRequest: requireAdmin }, (req) =>
    readSshApprovals(store).filter((a) => a.status === (req.query.status || 'pending') && visible(req.user!, a)).reverse());

  /** Tells the chat the agent asked from what became of its command, so it can go on. */
  const tellChat = (a: SshApproval, text: string) => {
    if (!a.conv || !store.getConversation(a.conv)) return;
    store.enqueue(a.conv, text, [], '', a.who);
    d.dispatcher.kick(a.conv);
  };
  const fence = '`'.repeat(3);
  const block = (a: SshApproval) => `\n\n${fence}sh\n${a.sudo ? 'sudo ' : ''}${a.command}\n${fence}`;
  // Approvals whose command is running now: another Approve or a Reject must wait for it.
  const running = new Set<number>();
  const decide = (verb: 'approve' | 'reject') => async (req: { params: { id: string }; user?: AuthUser }, reply: any) => {
    const a = readSshApprovals(store).find((x) => x.id === Number(req.params.id));
    if (!a || !visible(req.user!, a)) return reply.code(404).send({ error: 'not found' });
    if (running.has(a.id)) return reply.code(409).send({ error: 'already being run' });
    if (a.status !== 'pending') return reply.code(409).send({ error: `already ${a.status}` });
    const done = (patch: Partial<SshApproval>) => {
      Object.assign(a, { decidedBy: req.user!.name, decidedAt: Date.now(), ...patch });
      updateSshApproval(store, a.id, a);
    };
    if (verb === 'reject') {
      done({ status: 'rejected' });
      tellChat(a, `[SSH] An admin rejected your command on host "${a.host}"; it did not run. Do not run it again unless you are asked to.${block(a)}`);
      return a;
    }
    const h = find(req.user!, a.host);
    if (!h || h.agent === 'off') return reply.code(409).send({ error: 'this host is no longer open to agents; reject it instead' });
    running.add(a.id);
    const t0 = Date.now();
    const who = `${a.who || 'an agent'} (approved by ${req.user!.name})`;
    try {
      const r = await runCommand(h, a.command, { sudo: a.sudo, timeoutMs: Math.min(a.timeoutMs, PANEL_TIMEOUT_MAX_MS) });
      logSsh(store, h.id, { at: t0, who, conv: a.conv, command: a.command.slice(0, 4000), ...(a.sudo && { sudo: true }), ok: true, exitCode: r.exitCode, ms: r.ms });
      const outcome = describeRun(r);
      done({ status: 'approved', outcome });
      tellChat(a, `[SSH] An admin approved your command on host "${a.host}" and it ran.${block(a)}\n\nResult: ${outcome}`);
    } catch (e) {
      const msg = (e as Error).message;
      logSsh(store, h.id, { at: t0, who, conv: a.conv, command: a.command.slice(0, 4000), ...(a.sudo && { sudo: true }), ok: false, ms: Date.now() - t0, error: msg });
      done({ status: 'failed', outcome: msg });
      tellChat(a, `[SSH] An admin approved your command on host "${a.host}", but it could not run.${block(a)}\n\nError: ${msg}`);
    } finally {
      running.delete(a.id);
    }
    return a;
  };
  app.post<{ Params: { id: string } }>('/api/ssh/approvals/:id/approve', { onRequest: requireAdmin }, decide('approve'));
  app.post<{ Params: { id: string } }>('/api/ssh/approvals/:id/reject', { onRequest: requireAdmin }, decide('reject'));
}
