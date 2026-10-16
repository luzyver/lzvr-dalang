import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { basename, extname } from 'node:path';
import { Accounts, DEFAULT_LIMIT_RE, isLimit, retryAfterMs } from './accounts.js';
import { runClaudeTurn } from './claude.js';
import { runTurn } from './codex.js';
import { codexDiffs, rolloutFileChanges, type FileDiff } from './diff.js';
import { isRepo, saveCheckpoint } from './git.js';
import { RAW, type CodexEvent } from './runner.js';
import { codexLimits, findRollout, type LimitWindow } from './sessions.js';
import type { Conversation, QueueItem, Store } from './store.js';
import type { Backend } from './util.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export interface LiveEvent { id: number; type: string; payload: string; created_at: string }


export interface DispatcherOpts {
  /** One CODEX_HOME per account, in failover order. */
  homes: string[];
  command?: string[];
  /** Claude Code accounts (CLAUDE_CONFIG_DIR), in failover order, and how to start the CLI. */
  claudeHomes?: string[];
  claudeCommand?: string[];
  env?: Record<string, string>;
  blockMs?: number;
  limitRe?: RegExp;
  /** When set, each turn gets this MCP endpoint and a token bound to its conversation (see issueMcpToken). */
  mcpUrl?: string;
  /** Have the chat's agent give each new chat a short title from its first prompt (else the prompt itself is the title). */
  autoTitle?: boolean;
  /** Snapshot the agent's folder before and after each turn, so a turn's changes can be shown and undone (default on). */
  checkpoints?: boolean;
  /** Called after every turn (completed, failed or cancelled), e.g. to send a push notification. */
  onTurnEnd?: (e: { convId: string; project: string; status: string; lastMessage: string }) => void;
}

export interface ModelInfo { slug: string; name: string; description: string; efforts: string[] }

export function parseCodexModels(out: string): ModelInfo[] {
  const j = JSON.parse(out) as { models: { slug: string; display_name?: string; description?: string; visibility?: string; supported_reasoning_levels?: { effort: string }[] }[] };
  return j.models.filter((m) => m.visibility === 'list').map((m) => ({
    slug: m.slug, name: m.display_name ?? m.slug, description: m.description ?? '', efforts: (m.supported_reasoning_levels ?? []).map((r) => r.effort),
  }));
}

/** The model list from Claude Code's reply to an `initialize` control request, one JSON object per line. */
export function parseClaudeModels(out: string): ModelInfo[] {
  type M = { value: string; displayName?: string; description?: string; supportedEffortLevels?: string[] | null };
  for (const line of out.split('\n')) {
    let j: { type?: string; response?: { response?: { models?: M[] } } };
    try { j = JSON.parse(line); } catch { continue; }
    const models = j.type === 'control_response' ? j.response?.response?.models : undefined;
    // "default" is the CLI's own fallback, not a --model value; leaving the model unset already means that.
    if (models) return models.filter((m) => m.value !== 'default').map((m) => ({
      slug: m.value, name: m.displayName ?? m.value, description: m.description ?? '', efforts: m.supportedEffortLevels ?? [],
    }));
  }
  return [];
}

/** The first line of an answer, without the quotes, heading marks or final full stop agents like to add. */
export function cleanTitle(answer: string): string {
  const line = answer.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const bare = (s: string) => s.replace(/^["'`*]+|["'`*]+$/g, '').replace(/[.!。]+$/, '').trim();
  return bare(bare(line.replace(/^(?:#+\s*)?(?:title:\s*)?/i, ''))).slice(0, 80); // twice: `"Fix it".` as well as `"Fix it."`
}

export class Dispatcher {
  readonly accounts: Accounts;
  readonly claudeAccounts: Accounts;
  private modelCache = new Map<Backend, { at: number; list: ModelInfo[] }>();
  private active = new Map<string, AbortController>();
  private bus = new EventEmitter();
  private stopping = false;
  private mcpTokens = new Map<string, { convId: string; author: string }>(); // token -> the turn it was minted for
  /**
   * The environment that makes git, gh, glab and ssh inside a turn work as the panel user it runs for (QueueItem.on_behalf,
   * by name; 'owner' = the server's own setup). Set by the app; unset, turns use whatever the server has.
   */
  gitEnvFor?: (name: string, projectId: string) => Record<string, string>;
  private rollouts = new Map<string, string>(); // Codex thread id -> its rollout file

  constructor(private store: Store, private opts: DispatcherOpts) {
    this.accounts = new Accounts([...opts.homes], opts.blockMs); // own copy: accounts can be added while running
    this.claudeAccounts = new Accounts([...(opts.claudeHomes ?? [])], opts.blockMs);
    this.bus.setMaxListeners(0);
  }

  private accountsOf(backend: Backend): Accounts { return backend === 'claude' ? this.claudeAccounts : this.accounts; }

  /** Usage windows last seen for an account (null until one of its turns reported them). */
  limitsFor(backend: Backend, name: string): { windows: LimitWindow[]; at: number } | null {
    try { return JSON.parse(this.store.getKv(`limits:${backend}:${name}`) ?? 'null'); } catch { return null; }
  }
  private recordLimits(backend: Backend, home: string, windows: LimitWindow[]): void {
    if (windows.length) this.store.setKv(`limits:${backend}:${basename(home)}`, JSON.stringify({ windows, at: Date.now() }));
  }

  /** Switch an account on or off for new turns. Returns false if there is no such account. */
  setEnabled(backend: Backend, name: string, enabled: boolean): boolean {
    const accounts = this.accountsOf(backend);
    const home = accounts.homes.find((h) => basename(h) === name);
    if (!home) return false;
    accounts.setEnabled(home, enabled);
    const off = new Set(this.disabledList());
    if (enabled) off.delete(`${backend}:${name}`); else off.add(`${backend}:${name}`);
    this.store.setKv('disabled_accounts', JSON.stringify([...off]));
    return true;
  }
  private disabledList(): string[] {
    try { return JSON.parse(this.store.getKv('disabled_accounts') ?? '[]') as string[]; } catch { return []; }
  }
  /** Re-apply the saved on/off switches once the accounts are loaded at startup. */
  loadDisabled(): void {
    for (const key of this.disabledList()) {
      const [backend, name] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      if (backend === 'codex' || backend === 'claude') this.setEnabled(backend, name, false);
    }
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
   * `author` is the panel user who sent the turn's prompt ('owner' for the owner, '' for an agent or approval).
   */
  issueMcpToken(convId: string, author = ''): string {
    const token = randomBytes(32).toString('hex');
    this.mcpTokens.set(token, { convId, author });
    return token;
  }
  mcpConversation(token: string): string | null { return this.mcpTokens.get(token)?.convId ?? null; }
  mcpAuthor(token: string): string { return this.mcpTokens.get(token)?.author ?? ''; }
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

  isRunning(convId: string): boolean { return this.active.has(convId); }

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

  /**
   * The models the CLI offers, cached 10 minutes. Empty if it cannot say (the panel falls back to free text).
   * Codex: `codex debug models`. Claude Code: the `initialize` reply of its stream-json control protocol (what /model lists).
   */
  models(backend: Backend = 'codex'): Promise<ModelInfo[]> {
    const cached = this.modelCache.get(backend);
    if (cached && Date.now() - cached.at < 600_000) return Promise.resolve(cached.list);
    const claude = backend === 'claude';
    const home = this.accountsOf(backend).primary();
    const [cmd, ...pre] = (claude ? this.opts.claudeCommand : this.opts.command) ?? [claude ? 'claude' : 'codex'];
    const args = claude ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'] : ['debug', 'models'];
    const homeEnv = home ? { [claude ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: home } : {};
    return new Promise((done) => {
      const child = execFile(cmd!, [...pre, ...args], { env: { ...process.env, ...this.opts.env, ...homeEnv }, timeout: 30_000, maxBuffer: 8e6 }, (err, out) => {
        let list: ModelInfo[] = [];
        try { list = claude ? parseClaudeModels(out) : parseCodexModels(out); } catch { /* not JSON / CLI missing */ }
        if (!err || list.length) this.modelCache.set(backend, { at: Date.now(), list });
        done(list);
      });
      // Claude answers `initialize` and exits at end of input; Codex reads nothing, so it must not wait on stdin either.
      if (claude) child.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } })}\n`);
      child.stdin?.end();
    });
  }

  /**
   * One throwaway request outside any chat, e.g. drafting a commit message: read-only, no tools, and no session is kept
   * (so nothing shows up to adopt or resume). Tries each account once, skipping ones at their limit. Returns the answer.
   */
  async ask(backend: Backend, prompt: string, o: { cwd: string; model?: string; effort?: string; timeoutMs?: number }): Promise<string> {
    const claude = backend === 'claude';
    const accounts = this.accountsOf(backend);
    const model = o.model || this.store.getDefaultModel(backend);
    const effort = o.effort || this.store.getDefaultEffort(backend);
    const signal = AbortSignal.timeout(o.timeoutMs ?? 120_000);
    let error = accounts.homes.length ? 'every account is switched off or at its usage limit' : `no ${claude ? 'Claude Code' : 'Codex'} account has been added yet`;
    for (let home = accounts.pick(); home; home = accounts.pick()) {
      const extraArgs = claude
        ? ['--no-session-persistence', '--tools', '']
        : ['--ephemeral', ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : [])];
      const events = claude
        ? runClaudeTurn({ command: this.opts.claudeCommand, home, env: this.opts.env, cwd: o.cwd, sandbox: 'read-only', prompt, model, effort, extraArgs, signal })
        : runTurn({ command: this.opts.command, home, env: this.opts.env, cwd: o.cwd, sandbox: 'read-only', prompt, extraArgs, signal });
      let answer = '';
      let limited = false;
      error = 'the agent gave no answer';
      for await (const ev of events) {
        const item = ev.item as { type?: string; text?: unknown } | undefined;
        if (ev.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') answer = item.text;
        if (ev.type === 'turn.failed' || ev.type === 'error' || ev.type === 'process.exit') {
          const e = ev as { error?: { message?: string }; message?: string; stderr?: string };
          error = String(e.error?.message ?? e.message ?? e.stderr ?? ev.type).slice(-500);
          if (!limited && isLimit(ev, this.opts.limitRe ?? DEFAULT_LIMIT_RE)) {
            limited = true;
            accounts.block(home, retryAfterMs(ev, this.opts.blockMs ?? 60 * 60 * 1000));
          }
        }
      }
      if (signal.aborted) throw new Error('no answer within the time limit');
      if (answer.trim()) return answer;
      if (!limited) break;
    }
    throw new Error(error);
  }

  /** Ask for a short title for a chat from its first prompt and store it. On failure the first prompt stays the title. */
  private async titleChat(conv: Conversation, turnId: number, cwd: string, prompt: string): Promise<void> {
    const ask = 'Write a short title for a chat that starts with the request below: at most 6 words, in the same language '
      + 'as the request, naming what it is about. No quotes, no punctuation at the end. Do not run any tools. Reply with the '
      + `title only.\n\nRequest:\n${prompt.slice(0, 4000)}`;
    try {
      const title = cleanTitle(await this.ask(conv.backend, ask, { cwd, model: conv.model, effort: conv.effort, timeoutMs: 60_000 }));
      if (!title || !this.store.getConversation(conv.id)) return; // nothing usable, or the chat was deleted meanwhile
      this.store.setTitle(conv.id, title);
      this.emit(conv.id, turnId, { type: 'conversation.title', title });
    } catch (e) {
      console.warn(`could not title chat ${conv.id}: ${(e as Error).message}`);
    }
  }

  private emit(convId: string, turnId: number, ev: CodexEvent | { type: 'turn.status'; status: 'idle' | 'failed' }): void {
    const payload = (ev as { [RAW]?: string })[RAW] ?? JSON.stringify(ev);
    const id = this.store.addEvent(turnId, ev.type, payload);
    const created_at = this.store.eventCreatedAt(id) ?? new Date().toISOString();
    this.bus.emit(convId, { id, type: ev.type, payload, created_at } satisfies LiveEvent);
  }

  /**
   * Codex's exec JSON only names the changed files; the diffs are in the session's rollout, which Codex writes at about
   * the same moment, so wait for it briefly. Without a match the event goes out as it is.
   */
  private async withCodexDiffs(ev: CodexEvent, threadId: string | null, sinceMs: number, used: Set<string>): Promise<CodexEvent> {
    const item = ev.item as { changes?: FileDiff[] };
    const home = this.accounts.primary();
    if (!threadId || !home || !Array.isArray(item.changes) || !item.changes.length) return ev;
    for (let i = 0; i < 8; i++) {
      if (i) await new Promise((r) => setTimeout(r, 125));
      const file = this.rollouts.get(threadId) ?? findRollout(home, threadId);
      if (!file) continue;
      this.rollouts.set(threadId, file);
      const changes = codexDiffs(item.changes, rolloutFileChanges(file, sinceMs), used);
      if (changes) return { ...ev, item: { ...item, changes } };
    }
    return ev;
  }

  /** A checkpoint of the folder (see saveCheckpoint). Never fails the turn: one that cannot be taken is only logged. */
  private async checkpoint(cwd: string, convId: string, name: string): Promise<void> {
    if (!this.store.getConversation(convId)) return; // deleted meanwhile: its checkpoints are being dropped
    try { await saveCheckpoint(cwd, convId, name); } catch (e) { console.warn(`no checkpoint ${name} for chat ${convId}: ${(e as Error).message}`); }
  }

  private async run(convId: string, item: QueueItem, ac: AbortController): Promise<void> {
    const conv = this.store.getConversation(convId);
    const project = conv && this.store.getProject(conv.project_id);
    if (!conv || !project) return; // deleted while queued

    const claude = conv.backend === 'claude';
    const cwd = conv.worktree ?? project.path; // a chat with its own worktree never touches the project folder
    const accounts = claude ? this.claudeAccounts : this.accounts;
    const label = claude ? 'Claude Code' : 'Codex';
    // Claude Code takes no image flag: it opens attached images itself from the path in the prompt.
    const images = claude ? [] : item.attachments.filter((p) => IMAGE_EXT.has(extname(p).toLowerCase()));
    const others = item.attachments.filter((p) => !images.includes(p));
    const prompt = others.length
      ? `${item.prompt}\n\nAttached files:\n${others.map((p) => `- ${p}`).join('\n')}`
      : item.prompt;

    const turnId = this.store.startTurn(convId, item.prompt);
    this.store.setStatus(convId, 'running');
    this.emit(convId, turnId, { type: 'user.prompt', text: item.prompt, ...(item.author && { author: item.author }),
      ...(item.attachments.length > 0 && { attachments: item.attachments }) }); // so replayed history shows what was asked
    if (this.opts.autoTitle && !conv.auto_title && this.store.listTurns(convId).length === 1) {
      void this.titleChat(conv, turnId, cwd, item.prompt); // alongside the turn: it must not hold it up
    }
    const checkpoints = this.opts.checkpoints !== false && project.sandbox !== 'read-only' && (await isRepo(cwd).catch(() => false));
    if (checkpoints) await this.checkpoint(cwd, convId, `${turnId}-before`);
    let failed = false;
    let usage: unknown = null;
    let lastMessage = '';
    let workDone = false; // did an earlier attempt of THIS turn already do something (run a command, answer, ...)?
    // Optional: let the agent call this gateway's MCP endpoint, as exactly this conversation.
    const mcpToken = this.opts.mcpUrl ? this.issueMcpToken(convId, item.author) : null;
    // The agent's own git commands (commit, push) work as the user this turn runs for, never as someone else.
    const gitEnv = this.gitEnvFor?.(item.on_behalf || item.author, project.id) ?? {};
    // `codex exec` cannot ask before an MCP call (it fails with "requires approval, but approval policy is never"), so
    // the gateway's tools are approved up front; the per-turn token already limits them to what this chat may do.
    const extraArgs = this.opts.mcpUrl && !claude
      ? ['-c', `mcp_servers.dalang.url="${this.opts.mcpUrl}"`, '-c', 'mcp_servers.dalang.bearer_token_env_var="LZVR_MCP_TOKEN"',
        '-c', 'mcp_servers.dalang.default_tools_approval_mode="approve"']
      : [];
    const model = conv.model || this.store.getDefaultModel(conv.backend);
    const effort = conv.effort || this.store.getDefaultEffort(conv.backend);
    if (!claude) {
      if (model) extraArgs.push('-m', model);
      if (effort) extraArgs.push('-c', `model_reasoning_effort="${effort}"`);
    }
    try {
      // One attempt per account: a usage limit moves the SAME turn to the next account, resuming the thread.
      for (;;) {
        const home = accounts.pick();
        if (!home) {
          failed = true;
          this.emit(convId, turnId, {
            type: 'account.exhausted',
            message: accounts.homes.length === 0
              ? `no ${label} account has been added yet: an admin needs to add one in the panel and sign in`
              : 'every account is switched off or at its usage limit',
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
        const attemptStart = Date.now() - 1000;
        const usedDiffs = new Set<string>();
        // After work has already happened, resending the bare request makes the agent redo it (commits, deploys...).
        const attemptPrompt = workDone
          ? `Continue where you left off. An earlier attempt of this request was interrupted when its account hit a usage limit. ` +
            `Check what is already done and do not repeat completed steps.\n\nOriginal request:\n${prompt}`
          : prompt;
        const env = { ...this.opts.env, ...gitEnv, ...(mcpToken && { LZVR_MCP_TOKEN: mcpToken }) };
        const events = claude
          ? runClaudeTurn({
            command: this.opts.claudeCommand, home, env, cwd, sandbox: project.sandbox, threadId,
            prompt: attemptPrompt, model, effort, mcpUrl: this.opts.mcpUrl, signal: ac.signal,
          })
          : runTurn({
            command: this.opts.command, home, extraArgs, env, cwd, sandbox: project.sandbox, threadId,
            prompt: attemptPrompt, images, signal: ac.signal,
          });
        for await (let ev of events) {
          if (!claude && ev.type === 'item.completed' && (ev.item as { type?: string } | undefined)?.type === 'file_change') {
            ev = await this.withCodexDiffs(ev, this.store.getConversation(convId)?.thread_id ?? null, attemptStart, usedDiffs);
          }
          if (ev.type === 'account.limits') { this.recordLimits('claude', home, ev.windows as LimitWindow[]); continue; }
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
        if (!claude) { // Codex only reports usage inside the session file it writes
          const t = this.store.getConversation(convId)?.thread_id;
          const sessionsHome = this.accounts.primary();
          if (t && sessionsHome) this.recordLimits('codex', home, codexLimits(sessionsHome, t));
        }
        if (limited && !completed && !ac.signal.aborted) {
          accounts.block(home, limitMs);
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
    if (checkpoints) await this.checkpoint(cwd, convId, `${turnId}-after`);
    this.store.endTurn(turnId, status, usage);
    const conversationStatus = failed && !cancelled ? 'failed' : 'idle';
    this.store.setStatus(convId, conversationStatus);
    this.emit(convId, turnId, { type: 'turn.status', status: conversationStatus });
    if (interrupted) return; // shutting down: no notification
    try { this.opts.onTurnEnd?.({ convId, project: project.name, status, lastMessage }); } catch (e) { console.error('onTurnEnd failed', e); }
  }
}
