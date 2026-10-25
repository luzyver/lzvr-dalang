import type { FastifyInstance, FastifyReply } from 'fastify';
import { FORGES } from './forge.js';
import { GitAuthError } from './git-auth.js';
import type { GitUsers } from './git-users.js';
import type { AuthUser } from './util.js';

const STATUS: Record<GitAuthError['code'], number> = { 'bad-input': 400, exists: 409, busy: 409, 'not-found': 404, failed: 502 };

/** Turn a GitAuthError into its HTTP answer; anything else is a real bug and goes to Fastify's 500. */
async function handle<T>(reply: FastifyReply, fn: () => Promise<T> | T): Promise<T | FastifyReply> {
  try { return await fn(); } catch (e) {
    if (e instanceof GitAuthError) return reply.code(STATUS[e.code]).send({ error: e.message });
    throw e;
  }
}

const host = { type: 'string', minLength: 1, maxLength: 260 };
const forge = { type: 'string', enum: [...FORGES] };

/**
 * Settings → Git: git identity, SSH keys and the gh/glab logins. The owner manages the server's own (what the owner's
 * chats push with); every other panel user, admins included, manages their own setup (see GitUsers), which their
 * commits, pushes and Merge Requests then use.
 */
export function gitAuthRoutes(app: FastifyInstance, d: { users: GitUsers }): void {
  const signedIn = async (req: { user?: AuthUser }, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
  };
  const onRequest = signedIn;
  /** The setup this request is about: the server's for the owner, the caller's own for anyone else. */
  const authOf = (req: { user?: AuthUser }) => d.users.auth(req.user!.id);

  // Local and quick. The forge logins are asked separately: `gh auth status` checks the token over the network.
  app.get('/api/settings/git', { onRequest }, async (req) => {
    const auth = authOf(req);
    const [identity, keys, helpers] = await Promise.all([auth.identity(), auth.sshKeysWithFingerprints(), auth.credentialHelpers()]);
    return { scope: req.user!.id === null ? 'server' : 'user', identity, keys, helpers, aliases: auth.sshAliases() };
  });

  app.get<{ Params: { forge: 'github' | 'gitlab' } }>('/api/settings/git/forges/:forge', {
    onRequest, schema: { params: { type: 'object', properties: { forge } } },
  }, (req) => authOf(req).forgeStatus(req.params.forge));

  app.put<{ Body: { name: string; email: string } }>('/api/settings/git/identity', {
    onRequest,
    schema: { body: { type: 'object', required: ['name', 'email'], additionalProperties: false, properties: {
      name: { type: 'string', maxLength: 200 }, email: { type: 'string', maxLength: 200 },
    } } },
  }, (req, reply) => handle(reply, async () => {
    const name = req.body.name.trim();
    const email = req.body.email.trim();
    if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new GitAuthError('bad-input', 'that does not look like an email address');
    await authOf(req).setIdentity(name, email);
    return authOf(req).identity();
  }));

  app.post<{ Body: { name: string; comment: string } }>('/api/settings/git/ssh-keys', {
    onRequest,
    schema: { body: { type: 'object', required: ['name', 'comment'], additionalProperties: false, properties: {
      name: { type: 'string', maxLength: 64 }, comment: { type: 'string', maxLength: 200 },
    } } },
  }, (req, reply) => handle(reply, async () => reply.code(201).send(await authOf(req).generateKey(req.body.name.trim(), req.body.comment.trim()))));

  // `Host <alias>` blocks in ~/.ssh/config: one key per account on the same forge.
  app.post<{ Body: { alias: string; hostName: string; key: string } }>('/api/settings/git/ssh-aliases', {
    onRequest,
    schema: { body: { type: 'object', required: ['alias', 'hostName', 'key'], additionalProperties: false, properties: {
      alias: host, hostName: host, key: { type: 'string', maxLength: 64 },
    } } },
  }, (req, reply) => handle(reply, () => reply.code(201).send(authOf(req).addSshAlias(req.body.alias.trim(), req.body.hostName.trim().toLowerCase(), req.body.key))));
  app.delete<{ Params: { alias: string } }>('/api/settings/git/ssh-aliases/:alias', { onRequest }, (req, reply) =>
    handle(reply, () => { authOf(req).removeSshAlias(req.params.alias); return reply.code(204).send(); }));

  app.post<{ Body: { host: string } }>('/api/settings/git/ssh-test', {
    onRequest, schema: { body: { type: 'object', required: ['host'], additionalProperties: false, properties: { host } } },
  }, (req, reply) => handle(reply, () => authOf(req).testSsh(req.body.host.trim().toLowerCase())));

  app.post<{ Body: { forge: 'github' | 'gitlab'; host: string; token: string; https: boolean; apiHttp?: boolean } }>('/api/settings/git/login', {
    onRequest,
    schema: { body: { type: 'object', required: ['forge', 'host', 'token', 'https'], additionalProperties: false, properties: {
      forge, host, token: { type: 'string', minLength: 1, maxLength: 500 }, https: { type: 'boolean' }, apiHttp: { type: 'boolean' },
    } } },
  }, (req, reply) => handle(reply, async () => {
    const b = req.body;
    await authOf(req).login(b.forge, b.host.trim().toLowerCase(), b.token.trim(), b.https, b.apiHttp ?? false);
    return authOf(req).forgeStatus(b.forge);
  }));

  app.post<{ Body: { forge: 'github' | 'gitlab'; host: string; user?: string } }>('/api/settings/git/logout', {
    onRequest,
    schema: { body: { type: 'object', required: ['forge', 'host'], additionalProperties: false, properties: {
      forge, host, user: { type: 'string', maxLength: 100, pattern: '^[\\w.-]*$' },
    } } },
  }, (req, reply) => handle(reply, async () => {
    await authOf(req).logout(req.body.forge, req.body.host, req.body.user || undefined);
    return authOf(req).forgeStatus(req.body.forge);
  }));

  // gh only: glab keeps a single login per host.
  app.post<{ Body: { host: string; user: string } }>('/api/settings/git/switch', {
    onRequest,
    schema: { body: { type: 'object', required: ['host', 'user'], additionalProperties: false, properties: {
      host, user: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[\\w.-]+$' },
    } } },
  }, (req, reply) => handle(reply, async () => {
    await authOf(req).switchAccount(req.body.host.trim().toLowerCase(), req.body.user);
    return authOf(req).forgeStatus('github');
  }));

  app.post<{ Body: { forge: 'github' | 'gitlab'; host: string } }>('/api/settings/git/https', {
    onRequest, schema: { body: { type: 'object', required: ['forge', 'host'], additionalProperties: false, properties: { forge, host } } },
  }, (req, reply) => handle(reply, async () => {
    await authOf(req).setupHttps(req.body.forge, req.body.host);
    return { helpers: await authOf(req).credentialHelpers() };
  }));

  app.post<{ Body: { forge: 'github' | 'gitlab'; host: string; key: string; title: string } }>('/api/settings/git/upload-key', {
    onRequest,
    schema: { body: { type: 'object', required: ['forge', 'host', 'key', 'title'], additionalProperties: false, properties: {
      forge, host, key: { type: 'string', maxLength: 64 }, title: { type: 'string', maxLength: 100 },
    } } },
  }, (req, reply) => handle(reply, async () => ({ output: await authOf(req).uploadKey(req.body.forge, req.body.host, req.body.key, req.body.title.trim()) })));

  // GitHub's browser sign-in (one-time code), polled like an account login.
  app.post<{ Body: { host: string; https: boolean } }>('/api/settings/git/login-web', {
    onRequest,
    schema: { body: { type: 'object', required: ['host', 'https'], additionalProperties: false, properties: { host, https: { type: 'boolean' } } } },
  }, (req, reply) => handle(reply, () => reply.code(202).send({ id: authOf(req).startWebLogin(req.body.host.trim().toLowerCase(), req.body.https) })));
  app.get<{ Params: { id: string } }>('/api/settings/git/login-web/:id', { onRequest }, (req, reply) =>
    authOf(req).webLogin(req.params.id) ?? reply.code(404).send({ error: 'not found' }));
  app.delete<{ Params: { id: string } }>('/api/settings/git/login-web/:id', { onRequest }, (req, reply) =>
    authOf(req).cancelWebLogin(req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: 'not found' }));
}
