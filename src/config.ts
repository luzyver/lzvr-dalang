import { isIP } from 'node:net';
import { resolve } from 'node:path';

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
  /** How long an account stays skipped after hitting its usage limit. */
  limitBlockMs: number;
  /** Overrides the built-in usage-limit detection regex. */
  limitRegex?: RegExp;
  /** Passkeys: the site's hostname (e.g. panel.example.com) and its full origin (https://panel.example.com). */
  rpId?: string;
  origin?: string;
  /** Web Push contact (mailto: or https: URL) sent to push services. */
  vapidSubject?: string;
  /** A conversation messaging another one through MCP: hold for approval, or run straight away. */
  mcpCrossSend: 'approve' | 'auto';
  /** Give new chats a short generated title (off: the first prompt is the title). */
  autoTitle?: boolean;
  /** When set, every Codex turn is given this MCP endpoint plus a token bound to its conversation. */
  mcpUrl?: string;
}

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
  const port = Number(env.PORT ?? 9876);
  return {
    token,
    workspaceRoot: resolve(env.WORKSPACE_ROOT),
    stateDir: resolve(env.STATE_DIR ?? 'state'),
    port,
    host: env.HOST ?? '127.0.0.1',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    codexCommand: [env.CODEX_BIN ?? 'codex'],
    claudeCommand: [env.CLAUDE_BIN ?? 'claude'],
    limitBlockMs: blockMinutes * 60_000,
    mcpUrl: env.MCP_INJECT === '1' ? env.MCP_URL || `http://127.0.0.1:${port}/mcp` : undefined,
    limitRegex: env.LIMIT_REGEX ? new RegExp(env.LIMIT_REGEX, 'i') : undefined,
    rpId: env.LZVR_RP_ID || undefined,
    origin: env.LZVR_ORIGIN || undefined,
    vapidSubject: env.LZVR_VAPID_SUBJECT || undefined,
    mcpCrossSend: env.MCP_CROSS_SEND === 'auto' ? 'auto' : 'approve',
    autoTitle: env.AUTO_TITLE !== '0',
  };
}
