import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { DEFAULT_COMPACT_TOKENS } from './context.js';

export interface Config {
  token: string;
  workspaceRoot: string;
  stateDir: string;
  port: number;
  host: string;
  /**
   * Addresses/CIDRs of reverse proxies whose X-Forwarded-For is believed (empty = none). The client IP used for
   * rate limiting is then the entry that proxy appended, so a client cannot choose it by sending its own header.
   */
  trustProxy: string[];
  codexCommand: string[];
  claudeCommand: string[];
  /** How to start the GitHub and GitLab CLIs that open Merge Requests (default `gh` / `glab`). */
  ghCommand?: string[];
  glabCommand?: string[];
  /** Overrides telling GitHub from GitLab by the remote's host name (for self-hosted servers named otherwise). */
  forge?: 'github' | 'gitlab';
  /** How long an account stays skipped after hitting its usage limit. */
  limitBlockMs: number;
  /** On SIGTERM or a restart request, how long running turns may still finish before they are cut off (and resumed after). */
  drainMs: number;
  /** Overrides the built-in usage-limit detection regex. */
  limitRegex?: RegExp;
  /** The panel's full origin (https://panel.example.com): the Web Push contact when vapidSubject is unset. */
  origin?: string;
  /** Web Push contact (mailto: or https: URL) sent to push services. */
  vapidSubject?: string;
  /** A conversation messaging another one through MCP: hold for approval, or run straight away. */
  mcpCrossSend: 'approve' | 'auto';
  /** Give new chats a short generated title (off: the first prompt is the title). */
  autoTitle?: boolean;
  /** Keep what is worth keeping from each finished turn in its project's memory (see memory.ts; Settings can turn it off too). */
  autoMemory?: boolean;
  /** Native context compaction window in tokens; 0 leaves the CLI's own settings unchanged. */
  contextCompactTokens?: number;
  /** When set, every Codex turn is given this MCP endpoint plus a token bound to its conversation. */
  mcpUrl?: string;
  /** Mailer service base URL (`POST <url>/mail/send`) that delivers the sign-in codes. */
  mailerUrl?: string;
  /** Sender of the sign-in mail; the mailer's own default when unset. */
  mailFrom?: string;
  /** Emails that sign in as the owner (admin). Panel users sign in with the email set on their user. */
  ownerEmails: string[];
  /** Local development only: every request is the owner, no sign-in. Refused unless HOST is a loopback address. */
  authBypass: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** `1`/`true` mean "a proxy on this machine" (the usual nginx/Caddy setup); otherwise a comma-separated list of IPs/CIDRs. */
function parseTrustProxy(v: string | undefined): string[] {
  if (v === undefined || v === '' || v === '0' || v === 'false') return [];
  if (v === '1' || v === 'true') return ['127.0.0.1', '::1'];
  const list = v.split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of list) {
    const [addr, prefix, extra] = entry.split('/');
    if (!isIP(addr ?? '') || extra !== undefined || (prefix !== undefined && !/^\d{1,3}$/.test(prefix))) {
      throw new Error(`TRUST_PROXY must be 1 or a comma-separated list of proxy IPs/CIDRs (bad entry: ${entry})`);
    }
  }
  return list;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.LZVR_TOKEN ?? '';
  if (token.length < 32) throw new Error('LZVR_TOKEN must be at least 32 characters (try: openssl rand -hex 32)');
  if (!env.WORKSPACE_ROOT) throw new Error('WORKSPACE_ROOT is required');
  const blockMinutes = Number(env.LIMIT_BLOCK_MINUTES ?? 60);
  if (!Number.isFinite(blockMinutes) || blockMinutes <= 0) throw new Error('LIMIT_BLOCK_MINUTES must be a positive number');
  const drainMinutes = Number(env.DRAIN_MINUTES ?? 5);
  if (!Number.isFinite(drainMinutes) || drainMinutes < 0) throw new Error('DRAIN_MINUTES must be 0 or a positive number');
  const contextCompactTokens = Number(env.CONTEXT_COMPACT_TOKENS ?? DEFAULT_COMPACT_TOKENS);
  if (!Number.isInteger(contextCompactTokens) || (contextCompactTokens !== 0 && (contextCompactTokens < 100_000 || contextCompactTokens > 1_000_000))) {
    throw new Error('CONTEXT_COMPACT_TOKENS must be 0 or an integer from 100000 to 1000000');
  }
  const port = Number(env.PORT ?? 9876);
  const host = env.HOST ?? '127.0.0.1';
  const authBypass = env.AUTH_BYPASS === 'true' || env.AUTH_BYPASS === '1';
  if (authBypass && !LOOPBACK.has(host)) throw new Error('AUTH_BYPASS is for local development only: HOST must be 127.0.0.1, ::1 or localhost');
  if (env.GIT_FORGE && env.GIT_FORGE !== 'github' && env.GIT_FORGE !== 'gitlab') throw new Error('GIT_FORGE must be github or gitlab');
  return {
    token,
    workspaceRoot: resolve(env.WORKSPACE_ROOT),
    stateDir: resolve(env.STATE_DIR ?? 'state'),
    port,
    host,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    codexCommand: [env.CODEX_BIN ?? 'codex'],
    claudeCommand: [env.CLAUDE_BIN ?? 'claude'],
    ghCommand: [env.GH_BIN ?? 'gh'],
    glabCommand: [env.GLAB_BIN ?? 'glab'],
    forge: env.GIT_FORGE === 'github' || env.GIT_FORGE === 'gitlab' ? env.GIT_FORGE : undefined,
    limitBlockMs: blockMinutes * 60_000,
    drainMs: drainMinutes * 60_000,
    mcpUrl: env.MCP_INJECT === '1' ? env.MCP_URL || `http://127.0.0.1:${port}/mcp` : undefined,
    limitRegex: env.LIMIT_REGEX ? new RegExp(env.LIMIT_REGEX, 'i') : undefined,
    origin: env.LZVR_ORIGIN || undefined,
    vapidSubject: env.LZVR_VAPID_SUBJECT || undefined,
    mcpCrossSend: env.MCP_CROSS_SEND === 'auto' ? 'auto' : 'approve',
    autoTitle: env.AUTO_TITLE !== '0',
    autoMemory: env.AUTO_MEMORY !== '0',
    contextCompactTokens,
    mailerUrl: env.MAILER_URL?.replace(/\/+$/, '') || undefined,
    mailFrom: env.MAIL_FROM || undefined,
    ownerEmails: (env.LZVR_OWNER_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    authBypass,
  };
}
