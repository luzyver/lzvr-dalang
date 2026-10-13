import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { basename, extname } from 'node:path';
import { Accounts, DEFAULT_LIMIT_RE, isLimit, retryAfterMs } from './accounts.js';
import { RAW, runTurn, type CodexEvent } from './runner.js';
import type { QueueItem, Store } from './store.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export interface LiveEvent { id: number; type: string; payload: string; created_at: string }


export interface DispatcherOpts {
  /** One CODEX_HOME per account, in failover order. */
  homes: string[];
  command?: string[];
  env?: Record<string, string>;
  blockMs?: number;
  limitRe?: RegExp;
  /** When set, each turn gets this MCP endpoint and a token bound to its conversation (see issueMcpToken). */
  mcpUrl?: string;
  /** Called after every turn (completed, failed or cancelled), e.g. to send a push notification. */
  onTurnEnd?: (e: { convId: string; project: string; status: string; lastMessage: string }) => void;
}

export interface ModelInfo { slug: string; name: string; description: string; efforts: string[] }

export class Dispatcher {
  readonly accounts: Accounts;
  private modelCache: { at: number; list: ModelInfo[] } | null = null;
  private active = new Map<string, AbortController>();
  private bus = new EventEmitter();
  private stopping = false;
  private mcpTokens = new Map<string, string>(); // token -> the conversation whose turn it was minted for

  constructor(private store: Store, private opts: DispatcherOpts) {
    this.accounts = new Accounts([...opts.homes], opts.blockMs); // own copy: accounts can be added while running
    this.bus.setMaxListeners(0);
  }

  /** Start the next queued prompt if this conversation is idle. Safe to call any time. */
  kick(convId: string): void {
    if (this.stopping || this.active.has(convId)) return;
    const item = this.store.popQueue(convId);
    if (!item) return;
    const ac = new AbortController();
    this.active.set(convId, ac);
    void this.run(convId, item, ac)
      .catch((e) => console.error('dispatcher run failed', e))
      .finally(() => {
        this.active.delete(convId);
        try { this.kick(convId); } catch (e) { console.error('dispatcher kick failed', e); } // must not become an unhandled rejection
      });
  }

  /**
   * A bearer token that only works on /mcp and identifies the calling agent as running in `convId`.
   * The agent cannot choose who it is: the identity comes from the token, never from a header it sends.
   */
  issueMcpToken(convId: string): string {
    const token = randomBytes(32).toString('hex');
    this.mcpTokens.set(token, convId);
    return token;
  }
  mcpConversation(token: string): string | null { return this.mcpTokens.get(token) ?? null; }
  revokeMcpToken(token: string): void { this.mcpTokens.delete(token); }

  /**
   * Stop for good: kill every running turn (status `interrupted`) and refuse to start new ones. Resolves once nothing is running.
   */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.stopping = true;
    for (const ac of this.active.values()) ac.abort();
    const start = Date.now();
    while (this.active.size && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 25));
  }

  cancel(convId: string): boolean {
    const ac = this.active.get(convId);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  subscribe(convId: string, fn: (e: LiveEvent) => void): () => void {
    this.bus.on(convId, fn);
    return () => this.bus.off(convId, fn);
  }

  /** The models this Codex install offers (`codex debug models`), cached 10 minutes. Empty if Codex cannot say. */
  models(): Promise<ModelInfo[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 600_000) return Promise.resolve(this.modelCache.list);
    const home = this.accounts.primary();
    const [cmd, ...pre] = this.opts.command ?? ['codex'];
    return new Promise((done) => {
      const child = execFile(cmd!, [...pre, 'debug', 'models'], { env: { ...process.env, ...this.opts.env, ...(home ? { CODEX_HOME: home } : {}) }, timeout: 15_000, maxBuffer: 8e6 }, (err, out) => {
        let list: ModelInfo[] = [];
        try {
          const j = JSON.parse(out) as { models: { slug: string; display_name?: string; description?: string; visibility?: string; supported_reasoning_levels?: { effort: string }[] }[] };
          list = j.models.filter((m) => m.visibility === 'list').map((m) => ({
            slug: m.slug, name: m.display_name ?? m.slug, description: m.description ?? '', efforts: (m.supported_reasoning_levels ?? []).map((r) => r.effort),
          }));
        } catch { /* not JSON / codex missing: the panel falls back to free text */ }
        if (!err || list.length) this.modelCache = { at: Date.now(), list };
        done(list);
      });
      child.stdin?.end(); // a command that waits for input must not hang the request
    });
  }

  private emit(convId: string, turnId: number, ev: CodexEvent | { type: 'turn.status'; status: 'idle' | 'failed' }): void {
    const payload = (ev as { [RAW]?: string })[RAW] ?? JSON.stringify(ev);
    const id = this.store.addEvent(turnId, ev.type, payload);
    const created_at = this.store.eventCreatedAt(id) ?? new Date().toISOString();
    this.bus.emit(convId, { id, type: ev.type, payload, created_at } satisfies LiveEvent);
  }

  private async run(convId: string, item: QueueItem, ac: AbortController): Promise<void> {
    const conv = this.store.getConversation(convId);
    const project = conv && this.store.getProject(conv.project_id);
    if (!conv || !project) return; // deleted while queued

    const images = item.attachments.filter((p) => IMAGE_EXT.has(extname(p).toLowerCase()));
    const others = item.attachments.filter((p) => !images.includes(p));
    const prompt = others.length
      ? `${item.prompt}\n\nAttached files:\n${others.map((p) => `- ${p}`).join('\n')}`
      : item.prompt;

    const turnId = this.store.startTurn(convId, item.prompt);
    this.store.setStatus(convId, 'running');
    this.emit(convId, turnId, { type: 'user.prompt', text: item.prompt }); // so replayed history shows what was asked
    let failed = false;
    let usage: unknown = null;
    let lastMessage = '';
    let workDone = false; // did an earlier attempt of THIS turn already do something (run a command, answer, ...)?
    // Optional: let the agent call this gateway's MCP endpoint, as exactly this conversation.
    const mcpToken = this.opts.mcpUrl ? this.issueMcpToken(convId) : null;
    const extraArgs = this.opts.mcpUrl
      ? ['-c', `mcp_servers.dalang.url="${this.opts.mcpUrl}"`, '-c', 'mcp_servers.dalang.bearer_token_env_var="LZVR_MCP_TOKEN"']
      : [];
    const model = conv.model || this.store.getDefaultModel();
    if (model) extraArgs.push('-m', model);
    const effort = conv.effort || this.store.getDefaultEffort();
    if (effort) extraArgs.push('-c', `model_reasoning_effort="${effort}"`);
    try {
      // One attempt per account: a usage limit moves the SAME turn to the next account, resuming the thread.
      for (;;) {
        const home = this.accounts.pick();
        if (!home) {
          failed = true;
          this.emit(convId, turnId, {
            type: 'account.exhausted',
            message: this.accounts.homes.length === 0
              ? 'no Codex account has been added yet: an admin needs to click "+ Account" in the panel and sign in'
              : 'all accounts are at their usage limit',
          });
          break;
        }
        this.emit(convId, turnId, { type: 'account.selected', account: basename(home) });
        failed = false;
        let completed = false;
        let limited = false;
        let limitMs = 0;
        let worked = false;
        const threadId = this.store.getConversation(convId)?.thread_id ?? null;
        // After work has already happened, resending the bare request makes the agent redo it (commits, deploys...).
        const attemptPrompt = workDone
          ? `Continue where you left off. An earlier attempt of this request was interrupted when its account hit a usage limit. ` +
            `Check what is already done and do not repeat completed steps.\n\nOriginal request:\n${prompt}`
          : prompt;
        for await (const ev of runTurn({
          command: this.opts.command, home, extraArgs,
          env: mcpToken ? { ...this.opts.env, LZVR_MCP_TOKEN: mcpToken } : this.opts.env,
          cwd: project.path, sandbox: project.sandbox, threadId,
          prompt: attemptPrompt, images, signal: ac.signal,
        })) {
          if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') this.store.setThread(convId, ev.thread_id);
          if (ev.type.startsWith('item.')) worked = true;
          if (ev.type === 'turn.completed') { usage = ev.usage ?? null; failed = false; completed = true; }
          const msg = ev.item as { type?: string; text?: unknown } | undefined;
          if (ev.type === 'item.completed' && msg?.type === 'agent_message' && typeof msg.text === 'string') lastMessage = msg.text;
          if (ev.type === 'turn.failed' || ev.type === 'error' || ev.type === 'process.exit') {
            failed = true;
            if (!limited && isLimit(ev, this.opts.limitRe ?? DEFAULT_LIMIT_RE)) {
              limited = true;
              limitMs = retryAfterMs(ev, this.opts.blockMs ?? 60 * 60 * 1000);
            }
          }
          this.emit(convId, turnId, ev);
        }
        if (limited && !completed && !ac.signal.aborted) {
          this.accounts.block(home, limitMs);
          this.emit(convId, turnId, { type: 'account.switched', from: basename(home) });
          workDone ||= worked;
          continue;
        }
        break;
      }
    } catch (e) {
      failed = true;
      this.emit(convId, turnId, { type: 'process.exit', code: -1, stderr: String(e) });
    } finally {
      if (mcpToken) this.revokeMcpToken(mcpToken);
    }
    const cancelled = ac.signal.aborted;
    const interrupted = cancelled && this.stopping;
    const status = interrupted ? 'interrupted' : cancelled ? 'cancelled' : failed ? 'failed' : 'completed';
    this.store.endTurn(turnId, status, usage);
    const conversationStatus = failed && !cancelled ? 'failed' : 'idle';
    this.store.setStatus(convId, conversationStatus);
    this.emit(convId, turnId, { type: 'turn.status', status: conversationStatus });
    if (interrupted) return; // shutting down: no notification
    try { this.opts.onTurnEnd?.({ convId, project: project.name, status, lastMessage }); } catch (e) { console.error('onTurnEnd failed', e); }
  }
}
