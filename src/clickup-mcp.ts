/**
 * ClickUp's own MCP server (https://mcp.clickup.com/mcp), through which Dalang does everything in ClickUp. It takes no
 * personal API token, only OAuth 2.1 with PKCE, so each person connects their own ClickUp (Settings → MCP → ClickUp →
 * Connect) and the access token is theirs alone. Here: that sign-in (a client registered once per panel address, the
 * address to open, the code exchanged for a token), a tool call, and a file upload.
 */
import { createHash, randomBytes } from 'node:crypto';
import { ClickUpError, ClickUpUncertain, type OutFile } from './clickup.js';

export const CLICKUP_MCP = 'https://mcp.clickup.com';
const PROTOCOL = '2025-06-18';
const b64url = (b: Buffer) => b.toString('base64url');

/** A sign-in started and not finished yet: what the code is later exchanged with. */
export interface Pkce { state: string; verifier: string; challenge: string }

/** `state` starts with `cu_`, by which the panel knows a ClickUp sign-in came back to it. */
export function pkce(): Pkce {
  const verifier = b64url(randomBytes(48));
  return { state: `cu_${b64url(randomBytes(18))}`, verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

async function json(res: Response, what: string): Promise<any> {
  const body = await res.text().catch(() => '');
  if (!res.ok) throw new ClickUpError(`ClickUp ${res.status} on ${what}: ${body.slice(0, 300)}`, res.status);
  try { return JSON.parse(body); } catch { throw new ClickUpError(`ClickUp gave no JSON on ${what}`); }
}

export interface OAuthOpts { fetch?: typeof fetch; baseUrl?: string }

/** Registers this panel as a public OAuth client that comes back to `redirectUri`, and gives its client id. */
export async function registerClient(redirectUri: string, o: OAuthOpts = {}): Promise<string> {
  const res = await (o.fetch ?? fetch)(`${o.baseUrl ?? CLICKUP_MCP}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      client_name: 'Dalang', redirect_uris: [redirectUri], grant_types: ['authorization_code'], response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const id = (await json(res, 'registering the client'))?.client_id;
  if (typeof id !== 'string' || !id) throw new ClickUpError('ClickUp gave no client id');
  return id;
}

/** The address the person opens to sign in and allow access. */
export function authorizeUrl(clientId: string, redirectUri: string, p: Pkce, baseUrl = CLICKUP_MCP): string {
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: p.challenge, code_challenge_method: 'S256',
    state: p.state, scope: 'read write', resource: `${baseUrl}/mcp`,
  });
  return `${baseUrl}/oauth/authorize?${q}`;
}

/** The access token for the code ClickUp sent the person back with. */
export async function exchangeCode(q: { code: string; clientId: string; redirectUri: string; verifier: string }, o: OAuthOpts = {}): Promise<string> {
  const base = o.baseUrl ?? CLICKUP_MCP;
  const res = await (o.fetch ?? fetch)(`${base}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, signal: AbortSignal.timeout(20_000),
    body: String(new URLSearchParams({
      grant_type: 'authorization_code', code: q.code, client_id: q.clientId, redirect_uri: q.redirectUri, code_verifier: q.verifier,
      resource: `${base}/mcp`,
    })),
  });
  const token = (await json(res, 'signing in'))?.access_token;
  if (typeof token !== 'string' || !token) throw new ClickUpError('ClickUp gave no access token');
  return token;
}

/** Where a file goes: the next message of a channel or DM, the next reply in a message's thread, or a task. */
export type UploadTarget = { channel_id: string } | { parent_message_id: string } | { task_id: string };

/** A file as a message names it: shown in place when it is an image, else as a link. */
export const attachmentRef = (f: { id: string; name: string }) =>
  `${/\.(png|jpe?g|gif|webp)$/i.test(f.name) ? '!' : ''}[${f.name.replace(/[[\]]/g, '')}](#attachment#${f.id})`;

/** What a tool says when ClickUp refused the call, having done nothing: the thing is not there, not allowed or not valid. */
const REFUSAL = /not found|not accessible|no access|access denied|denied|invalid|not valid|unauthori[sz]ed|forbidden|permission|required|must |cannot|can't|does not exist|doesn't exist|not allowed|not supported|already/i;

export class ClickUpMcp {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private seq = 0;

  constructor(private readonly o: { token: string; fetch?: typeof fetch; baseUrl?: string }) {
    this.base = (o.baseUrl ?? CLICKUP_MCP).replace(/\/+$/, '');
    this.fetch = o.fetch ?? fetch;
  }

  /**
   * One tool called (the server keeps no session, so a call is one request), counted against `budget`, and what it
   * gave. A 429 is retried once after a short wait. `status` 4xx on the error says ClickUp refused and did nothing: the
   * request itself was refused, or the tool said why (not found, no access, not valid). Any other failure does not say
   * whether ClickUp acted, and is uncertain.
   */
  async call(name: string, args: Record<string, unknown> = {}, budget?: { left: number }): Promise<any> {
    if (budget && budget.left-- <= 0) throw new ClickUpError('request budget for this call used up');
    const id = ++this.seq;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }); // undefined arguments drop out
    let res: Response;
    let text: string;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this.fetch(`${this.base}/mcp`, {
          method: 'POST', body, signal: AbortSignal.timeout(60_000),
          headers: {
            authorization: `Bearer ${this.o.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
            'mcp-protocol-version': PROTOCOL,
          },
        });
        text = await res.text();
      } catch (e) { throw new ClickUpUncertain(`ClickUp did not answer ${name}: ${(e as Error).message}`); }
      if (res.status === 429 && attempt === 0) {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        const wait = reset ? reset - Date.now() : 5_000;
        if (wait <= 10_000) { await new Promise((r) => setTimeout(r, Math.max(wait, 500))); continue; }
      }
      break;
    }
    if (res.status === 401) throw new ClickUpError('ClickUp no longer accepts the connection; connect ClickUp again in Settings → MCP', 401);
    if (!res.ok) {
      const msg = `ClickUp ${res.status} on ${name}: ${text.slice(0, 300)}`;
      throw res.status >= 400 && res.status < 500 && res.status !== 408 ? new ClickUpError(msg, res.status) : new ClickUpUncertain(msg, res.status);
    }
    let msg: any;
    try {
      if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        const data = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
        msg = data.find((m) => m?.id === id) ?? data.at(-1);
      } else msg = JSON.parse(text);
    } catch { throw new ClickUpUncertain(`ClickUp gave no readable answer on ${name}`); }
    if (msg?.error) throw new ClickUpError(`ClickUp refused ${name}: ${String(msg.error.message ?? '').slice(0, 300)}`, 400);
    const r = msg?.result;
    const said = ((r?.content ?? []) as any[]).find((c) => c?.type === 'text')?.text;
    if (r?.isError) {
      let why = String(said ?? '');
      try { why = String(JSON.parse(why).error ?? why); } catch { /* plain text */ }
      why = why.slice(0, 300);
      throw REFUSAL.test(why) ? new ClickUpError(`ClickUp: ${why}`, 400) : new ClickUpUncertain(`ClickUp ${name} failed: ${why}`);
    }
    if (r?.structuredContent) return r.structuredContent;
    try { return JSON.parse(String(said ?? '')); } catch { throw new ClickUpUncertain(`ClickUp ${name} gave no JSON`); }
  }

  /**
   * Uploads a file and gives its id (a chat message names it by that) and, when ClickUp says it, its address. For a
   * message nothing shows in ClickUp until the message names the file; on a task the file is attached at once.
   */
  async upload(target: UploadTarget, f: OutFile, workspaceId?: string): Promise<{ id: string; name: string; url?: string }> {
    const failed = (why: string, status?: number) => new ClickUpError(`uploading ${f.name} failed: ${why}`, status);
    let t: any;
    try { t = await this.call('clickup_request_attachment_upload', { ...target, file_name: f.name, workspace_id: workspaceId }); } catch (e) {
      throw failed((e as Error).message, refusedStatus(e));
    }
    // The file and its ticket go only to ClickUp, whatever address the answer names.
    let url: URL | undefined;
    try { url = new URL(String(t?.upload_url)); } catch { /* refused below */ }
    const ours = url && (url.origin === new URL(this.base).origin || (url.protocol === 'https:' && /(^|\.)clickup\.com$/.test(url.hostname)));
    if (!url || !ours || !t?.upload_ticket) throw failed('ClickUp gave no upload address of its own', 400);
    const form = new FormData();
    form.append(String(t.multipart_field || 'attachment'), new Blob([new Uint8Array(f.data)]), f.name);
    let a: any;
    try {
      const res = await this.fetch(url, {
        method: 'POST', headers: { 'x-upload-ticket': String(t.upload_ticket), accept: 'application/json' }, body: form,
        signal: AbortSignal.timeout(120_000),
      });
      a = await json(res, 'the upload');
    } catch (e) { throw failed((e as Error).message, e instanceof ClickUpError ? e.status : undefined); }
    if (!a?.id) throw failed('ClickUp gave no id for it');
    return { id: String(a.id), name: String(a.title || f.name), ...(typeof a.url === 'string' && a.url && { url: a.url }) };
  }
}

/** The status of an error that says ClickUp refused (a 4xx), else undefined. */
const refusedStatus = (e: unknown) => (e instanceof ClickUpError && !(e instanceof ClickUpUncertain) ? e.status : undefined);
