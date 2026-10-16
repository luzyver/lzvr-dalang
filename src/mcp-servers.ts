/**
 * Settings → MCP: other MCP servers (Context7, Playwright, ...) given to the agents' turns next to this gateway's own.
 * They are the owner's: a turn the owner sent gets every enabled server, any other turn (admins, devs, agents,
 * approvals) only those marked "all users". Secrets (the bearer token, env values) never go back to the panel and never
 * onto a command line: the CLI reads them from the turn's environment.
 */
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import type { AuthUser } from './util.js';

export interface McpServerConf {
  name: string;
  enabled: boolean;
  /** Admins' and devs' turns get it too (else the owner's turns only). */
  allUsers: boolean;
  /** Streamable HTTP server: its URL and an optional bearer token. */
  url: string;
  token: string;
  /** stdio server: the command, its arguments and environment. */
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** What a turn adds to its CLI: Codex `-c` options, Claude Code `--mcp-config` entries, and the secrets they read. */
export interface McpLaunch { codexArgs: string[]; claudeServers: Record<string, object>; env: Record<string, string> }

const KEY = 'mcp_servers';
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// Variables a server's env may not set: they go into the agent's own environment too.
const RESERVED_ENV = /^(LZVR_.*|PATH|HOME|USERPROFILE|CODEX_HOME|CLAUDE_CONFIG_DIR)$/i;

export function loadMcpServers(store: Store): McpServerConf[] {
  try {
    const list = JSON.parse(store.getKv(KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

/** The servers a turn gets: `author` is who sent its prompt ('owner' for the owner, see QueueItem.author). */
export function mcpServersFor(store: Store, author: string): McpServerConf[] {
  return loadMcpServers(store).filter((s) => s.enabled && (author === 'owner' || s.allUsers));
}

/** The variable a server's bearer token is passed in. */
const tokenVar = (name: string) => `LZVR_MCPS_${name.toUpperCase().replace(/-/g, '_')}_TOKEN`;
/** A TOML string; a JSON string is a valid TOML basic string. */
const toml = (s: string) => JSON.stringify(s);

export function mcpLaunch(servers: McpServerConf[]): McpLaunch {
  const codexArgs: string[] = [];
  const claudeServers: Record<string, object> = {};
  const env: Record<string, string> = {};
  for (const s of servers) {
    const c = (k: string, v: string) => codexArgs.push('-c', `mcp_servers.${s.name}.${k}=${v}`);
    if (s.url) {
      c('url', toml(s.url));
      const headers: Record<string, string> = {};
      if (s.token) {
        env[tokenVar(s.name)] = s.token;
        c('bearer_token_env_var', toml(tokenVar(s.name)));
        headers.Authorization = `Bearer \${${tokenVar(s.name)}}`;
      }
      claudeServers[s.name] = { type: 'http', url: s.url, headers };
    } else {
      const keys = Object.keys(s.env);
      Object.assign(env, s.env);
      c('command', toml(s.command));
      c('args', `[${s.args.map(toml).join(',')}]`);
      if (keys.length) c('env_vars', `[${keys.map(toml).join(',')}]`);
      claudeServers[s.name] = {
        type: 'stdio', command: s.command, args: s.args, env: Object.fromEntries(keys.map((k) => [k, `\${${k}}`])),
      };
    }
    // `codex exec` cannot ask before an MCP call, so the server's tools are approved up front (Claude Code: --allowedTools).
    c('default_tools_approval_mode', toml('approve'));
  }
  return { codexArgs, claudeServers, env };
}

const hint = (secret: string) => (secret ? `…${secret.slice(-4)}` : '');
/** What the panel sees: no token or env value, only the token's last four characters and the env names. */
const view = (s: McpServerConf) => ({
  name: s.name, enabled: s.enabled, allUsers: s.allUsers, url: s.url, tokenHint: hint(s.token),
  command: s.command, args: s.args, envKeys: Object.keys(s.env),
});

interface Body {
  enabled: boolean; allUsers: boolean; url?: string; token?: string; command?: string; args?: string[];
  /** A null value keeps the saved one. */
  env?: Record<string, string | null>;
}

/** Settings → MCP, for the owner only. */
export function mcpServerRoutes(app: FastifyInstance, d: { store: Store }): void {
  const { store } = d;
  const requireOwner = async (req: { user?: AuthUser }, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    if (!req.user || req.user.id !== null) return reply.code(403).send({ error: 'owner only' });
  };
  const save = (list: McpServerConf[]) => store.setKv(KEY, JSON.stringify(list));

  app.get('/api/settings/mcp-servers', { onRequest: requireOwner }, () => loadMcpServers(store).map(view));

  // Adds or changes one server. `token`: omitted keeps the saved one, '' removes it.
  app.put<{ Params: { name: string }; Body: Body }>('/api/settings/mcp-servers/:name', {
    onRequest: requireOwner,
    schema: { body: {
      type: 'object', required: ['enabled', 'allUsers'], additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' }, allUsers: { type: 'boolean' },
        url: { type: 'string', maxLength: 500 }, token: { type: 'string', maxLength: 500 },
        command: { type: 'string', maxLength: 500 },
        args: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 500 } },
        env: { type: 'object', maxProperties: 30, additionalProperties: { type: ['string', 'null'], maxLength: 2000 } },
      },
    } },
  }, (req, reply) => {
    const { name } = req.params;
    const b = req.body;
    const bad = (m: string) => reply.code(400).send({ error: m });
    if (!NAME.test(name) || name === 'dalang') return bad('name: lowercase letters, digits, - and _ (not "dalang")');
    const list = loadMcpServers(store);
    const old = list.find((s) => s.name === name);
    const url = b.url?.trim() ?? '';
    const command = b.command?.trim() ?? '';
    if (Boolean(url) === Boolean(command)) return bad('give either a URL (HTTP server) or a command (stdio server)');
    if (url && !/^https?:\/\/\S+$/.test(url)) return bad('the URL must start with http:// or https://');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(command ? b.env ?? {} : {})) {
      if (!ENV_NAME.test(k) || RESERVED_ENV.test(k)) return bad(`env: ${k} cannot be set`);
      const value = v ?? old?.env[k];
      if (value === undefined) return bad(`env: ${k} has no value`);
      env[k] = value;
    }
    const next: McpServerConf = {
      name, enabled: b.enabled, allUsers: b.allUsers, url,
      token: url ? (b.token === undefined ? old?.token ?? '' : b.token.trim()) : '',
      command, args: command ? (b.args ?? []).filter((a) => a !== '') : [], env,
    };
    save(old ? list.map((s) => (s === old ? next : s)) : [...list, next]);
    return view(next);
  });

  app.delete<{ Params: { name: string } }>('/api/settings/mcp-servers/:name', { onRequest: requireOwner }, (req, reply) => {
    const list = loadMcpServers(store);
    if (!list.some((s) => s.name === req.params.name)) return reply.code(404).send({ error: 'no such server' });
    save(list.filter((s) => s.name !== req.params.name));
    return { ok: true };
  });
}
