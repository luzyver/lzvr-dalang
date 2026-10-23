import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Sealer } from './secrets.js';
import { AGENT_GIT_DEFAULTS, type AgentGitPolicy } from './agent-git.js';
import type { Backend, ProjectAccess } from './util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
  sandbox TEXT NOT NULL DEFAULT 'workspace-write', backend TEXT NOT NULL DEFAULT 'codex', access TEXT NOT NULL DEFAULT 'all');
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id TEXT, status TEXT NOT NULL DEFAULT 'idle', draft TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '', effort TEXT NOT NULL DEFAULT '', backend TEXT NOT NULL DEFAULT 'codex');
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL, attachments TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', usage TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, ended_at TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin','dev')),
  token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, from_conv TEXT NOT NULL, to_conv TEXT NOT NULL,
  prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL, cron TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER, last_run_at INTEGER, created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, user_key TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL, source_conv TEXT NOT NULL DEFAULT '', source_title TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((project_id IS NULL) <> (user_key = '')));
`;

export interface Approval {
  id: number; from_conv: string; to_conv: string; prompt: string;
  status: 'pending' | 'approved' | 'rejected'; created_at: string;
  /** The panel user the sending agent was working for (see QueueItem.on_behalf). */
  on_behalf: string;
}

export type Role = 'admin' | 'dev';
export interface User { id: string; name: string; role: Role; email: string | null; created_at: string }
export interface UserSummary { id: string; name: string; role: Role; email: string | null; createdAt: string }

/** `backend` is the agent CLI every chat in the project runs on; `access` who may open it (see canAccess). */
export interface Project { id: string; name: string; path: string; sandbox: string; backend: Backend; access: ProjectAccess }
export interface Conversation {
  id: string; project_id: string; thread_id: string | null;
  /** For display: the title the agent gave the chat, or else the start of its first prompt (null before any). */
  title?: string | null;
  /** The generated title alone (null until one exists). */
  auto_title?: string | null;
  status: 'idle' | 'running' | 'failed'; draft: string;
  /** Codex model for this chat; empty = Codex's own default. */
  model: string;
  /** Reasoning effort (low|medium|high|xhigh|max); empty = Codex's default for the model. */
  effort: string;
  /** Which agent CLI runs this chat. */
  backend: Backend;
  /** The chat's own git worktree (its agent works there instead of the project folder), or null. */
  worktree: string | null;
  /** The worktree's branch, and the branch of the project folder it was started from. */
  branch: string | null;
  base_branch: string | null;
  /** The Merge Request / pull request this chat opened last, or null, and the branch it is for (null in older rows). */
  pr_url: string | null;
  pr_branch: string | null;
  /** The chat whose agent created this one over MCP (a sub-agent), or '' when a person or an outside client did. */
  parent: string;
}
/**
 * `author`: the panel user who sent the prompt (or made its schedule); empty when an agent (MCP) or an approval queued it.
 * `on_behalf`: whose git setup the turn uses ('owner' = the server's): the author, or for a prompt one agent sent another
 * the user that agent was working for.
 */
export interface QueueItem {
  id: number; conversation_id: string; prompt: string; attachments: string[]; author: string; on_behalf: string;
  /** The chat whose agent sent this prompt over MCP, or ''. A sub-agent's answer to its parent goes back to it. */
  from_conv: string;
}
/**
 * How far agents may go with sub-agents: chats per parent, levels below a person's chat, and sending to them unasked.
 * `mode`: 'asked' = they start sub-agents only when told to; 'auto' = every turn that still may start one is told how and
 * when to, so the agent decides itself (`guide`, or the built-in SUBAGENT_GUIDE when empty).
 */
export interface SubagentPolicy { maxChildren: number; maxDepth: number; autoSend: boolean; mode: 'asked' | 'auto'; guide: string }
export const SUBAGENT_DEFAULTS: SubagentPolicy = { maxChildren: 5, maxDepth: 2, autoSend: true, mode: 'asked', guide: '' };
export const SUBAGENT_GUIDE = `You are running inside Dalang, and you may act as an orchestrator: hand parts of your task to sub-agents.
Use the dalang MCP tools for this (in Claude Code they may need loading first: search your tools for "mcp__dalang").
Prefer them over any built-in sub-agent tool for real work: Dalang sub-agents show up in the panel, keep their own session and follow the model limits.

When to: the task has parts that are independent of each other and big enough to be worth a fresh session (a separate
module, a review, a test run, research across many files). Do small or tightly coupled work yourself; do not split for its own sake.

How:
- list_models first: pick the weakest model that fits each part, with the lowest effort that fits.
- create_conversation with project_id, model, effort and the task as prompt. Give each sub-agent everything it needs
  (it does not see this chat), what it may change, and what its last answer must contain.
- worktree: true for a sub-agent that changes files, so parallel sub-agents never write over each other or you.
- Do not poll. When a sub-agent finishes, its last answer comes to this chat as a new message starting with [Sub-agent].
  End your turn after starting them; continue when the reports arrive.
- Check each report before relying on it. If one fell short, send_prompt it a correction, or set_model it one step up.
- At the end, sum up for the person what each sub-agent did and what you checked.`;
/**
 * Project and personal memory (see memory.ts). `auto`: after each finished turn of a person's chat, a small read-only
 * request picks what is worth keeping from it; `user`: that request may also keep the preferences the person states for
 * their own memory. `models`: what runs that request per backend ('' = the chat's own model); `effort` likewise.
 */
export interface MemoryPolicy { auto: boolean; user: boolean; models: Partial<Record<Backend, string>>; effort: string }
export const MEMORY_DEFAULTS: MemoryPolicy = { auto: true, user: true, models: {}, effort: 'low' };
export interface Turn {
  id: number; conversation_id: string; prompt: string; status: string;
  usage: string | null; started_at: string; ended_at: string | null;
}
/** A prompt queued into a chat on a cron schedule. Times are epoch milliseconds; `next_run_at` is null when off. */
export interface Schedule {
  id: number; conversation_id: string; prompt: string; cron: string; enabled: boolean;
  next_run_at: number | null; last_run_at: number | null; created_by: string; created_at: string;
}
/** A schedule with the names the overview shows. */
export interface ScheduleSummary extends Schedule { project_id: string; project: string; title: string | null }

/**
 * A fact kept for later chats (see memory.ts): of a project (`project_id`), or a person's own (`user_key`, see userKeyOf),
 * never both. It belongs to the project or the person, not to the chat it came from: `source_conv` and `source_title`
 * only say where it came from, and stay when that chat is deleted.
 * `created_by`: the panel user whose turn it came from, 'agent' when an agent saved it itself, or ''.
 */
export interface Memory {
  id: number; project_id: string | null; user_key: string; text: string; source_conv: string; source_title: string; created_by: string;
  created_at: string; updated_at: string;
}
/** Whose memories: a project's, or a person's own (their userKeyOf). */
export type MemoryScope = { projectId: string } | { userKey: string };
const scopeWhere = (s: MemoryScope): [string, string] => ('projectId' in s ? ['project_id=?', s.projectId] : ['user_key=?', s.userKey]);

/** A search match: a chat's title, one of its prompts or one of the agent's answers (then `event_id` locates it). */
export interface SearchHit {
  kind: 'title' | 'prompt' | 'answer'; conversation_id: string; project_id: string; project: string;
  title: string | null; text: string; event_id: number | null; created_at: string | null;
}

export interface StoredEvent { id: number; conversation_id: string; type: string; payload: string; created_at: string }

const TITLE = `COALESCE(c.auto_title, (SELECT substr(prompt, 1, 80) FROM turns t WHERE t.conversation_id=c.id ORDER BY t.id LIMIT 1))`;

/** A LIKE pattern (used with `ESCAPE '\'`) in which `%`, `_` and `\` match themselves. */
const likeTerm = (t: string) => `%${t.replace(/[\\%_]/g, '\\$&')}%`;

type ScheduleRow = Omit<Schedule, 'enabled'> & { enabled: number };
const toSchedule = <T extends ScheduleRow>(r: T): Omit<T, 'enabled'> & { enabled: boolean } => ({ ...r, enabled: !!r.enabled });

interface QueueRow { id: number; conversation_id: string; prompt: string; attachments: string; author: string; on_behalf: string; from_conv: string }
const toItem = (r: QueueRow): QueueItem => ({ ...r, attachments: JSON.parse(r.attachments) as string[] });

export class Store {
  readonly db: DatabaseSync;

  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    // Databases made by earlier versions lack these columns; CREATE TABLE IF NOT EXISTS does not add them.
    this.ensureColumn('sessions', 'user_id', 'TEXT REFERENCES users(id) ON DELETE CASCADE');
    this.ensureColumn('conversations', 'model', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('conversations', 'effort', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('projects', 'backend', "TEXT NOT NULL DEFAULT 'codex'");
    this.ensureColumn('projects', 'access', "TEXT NOT NULL DEFAULT 'all'");
    this.run("UPDATE projects SET access='all' WHERE access='dev'"); // 'dev' (owner, admins and devs) was the same as 'all'
    this.ensureColumn('conversations', 'backend', "TEXT NOT NULL DEFAULT 'codex'");
    this.ensureColumn('events', 'created_at', 'TEXT');
    this.ensureColumn('conversations', 'worktree', 'TEXT');
    this.ensureColumn('conversations', 'branch', 'TEXT');
    this.ensureColumn('conversations', 'base_branch', 'TEXT');
    this.ensureColumn('conversations', 'auto_title', 'TEXT');
    this.ensureColumn('conversations', 'pr_url', 'TEXT');
    this.ensureColumn('conversations', 'pr_branch', 'TEXT');
    this.ensureColumn('conversations', 'parent', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('users', 'email', 'TEXT');
    this.ensureColumn('queue', 'author', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('queue', 'on_behalf', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('queue', 'from_conv', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('approvals', 'on_behalf', "TEXT NOT NULL DEFAULT ''");
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email)'); // ALTER TABLE cannot add UNIQUE
    // A chat's history is read by its turns: without these, reading one chat scans the events of every chat.
    this.db.exec('CREATE INDEX IF NOT EXISTS turns_conversation ON turns(conversation_id); CREATE INDEX IF NOT EXISTS events_turn ON events(turn_id)');
    this.db.exec('DROP TABLE IF EXISTS passkeys'); // passkey sign-in was removed
    this.run(`UPDATE events SET created_at=(SELECT started_at FROM turns WHERE turns.id=events.turn_id) WHERE created_at IS NULL`);
    this.fts = this.memoryIndex();
  }

  /** Whether memories have a full-text index (SQLite's FTS5), which matchMemories ranks with; without it, it counts words. */
  private readonly fts: boolean;

  /**
   * The full-text index of the memories, kept in step by triggers (also when a project's go with it). Built from the
   * table when it is new. False when this SQLite has no FTS5.
   */
  private memoryIndex(): boolean {
    const had = this.get("SELECT 1 FROM sqlite_master WHERE name='memories_fts'") !== null;
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, content='memories', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text); END;
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF text ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
          INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text); END;`);
      if (!had) this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
      return true;
    } catch (e) {
      console.warn(`project memory: no full-text index (${(e as Error).message}); matching counts words instead`);
      return false;
    }
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  private get<T>(sql: string, ...args: (string | number)[]): T | null {
    return (this.db.prepare(sql).get(...args) as unknown as T | undefined) ?? null;
  }
  private all<T>(sql: string, ...args: (string | number)[]): T[] {
    return this.db.prepare(sql).all(...args) as unknown as T[];
  }
  private run(sql: string, ...args: (string | number | null | Uint8Array)[]) {
    return this.db.prepare(sql).run(...args);
  }

  // --- panel users (role admin or dev); the personal token is stored only as a hash ---
  /** `email` is stored lowercased; it is what the user signs in with (a one-time code is mailed to it). */
  createUser(name: string, role: Role, tokenHash: string, email: string | null = null): User {
    const id = randomUUID();
    this.run('INSERT INTO users (id,name,role,token_hash,email) VALUES (?,?,?,?,?)', id, name, role, tokenHash, email?.toLowerCase() ?? null);
    return this.getUser(id)!;
  }
  getUser(id: string): User | null { return this.get('SELECT id,name,role,email,created_at FROM users WHERE id=?', id); }
  getUserByTokenHash(hash: string): User | null { return this.get('SELECT id,name,role,email,created_at FROM users WHERE token_hash=?', hash); }
  getUserByEmail(email: string): User | null { return this.get('SELECT id,name,role,email,created_at FROM users WHERE email=?', email.toLowerCase()); }
  /** Throws when another user already has this email. */
  setUserEmail(id: string, email: string | null): boolean {
    return Number(this.run('UPDATE users SET email=? WHERE id=?', email?.toLowerCase() ?? null, id).changes) > 0;
  }
  listUsers(): UserSummary[] {
    return this.all('SELECT id, name, role, email, created_at AS createdAt FROM users ORDER BY rowid');
  }
  setUserRole(id: string, role: Role): boolean { return Number(this.run('UPDATE users SET role=? WHERE id=?', role, id).changes) > 0; }
  /** New token for a user; their old token and every open session stop working. */
  setUserToken(id: string, tokenHash: string): boolean {
    const changed = Number(this.run('UPDATE users SET token_hash=? WHERE id=?', tokenHash, id).changes) > 0;
    if (changed) this.run('DELETE FROM sessions WHERE user_id=?', id);
    return changed;
  }
  /** Their personal memory goes with them. */
  deleteUser(id: string): boolean {
    // Only once a user really went: 'owner' (whose memories are kept under that key) has no row and must not lose them.
    const deleted = Number(this.run('DELETE FROM users WHERE id=?', id).changes) > 0;
    if (deleted) this.run('DELETE FROM memories WHERE user_key=?', id);
    return deleted;
  }

  // --- login sessions, push subscriptions, small key/value settings ---
  /** `userId` null = a session of the owner (an owner email sign-in, not a panel user). */
  createSession(tokenHash: string, expiresAt: number, userId: string | null = null): void {
    this.run('DELETE FROM sessions WHERE expires_at<=?', Date.now()); // opportunistic cleanup
    this.run('INSERT OR REPLACE INTO sessions (token_hash,expires_at,user_id) VALUES (?,?,?)', tokenHash, expiresAt, userId);
  }
  deleteSession(tokenHash: string): void { this.run('DELETE FROM sessions WHERE token_hash=?', tokenHash); }
  getSession(tokenHash: string, now: number): { user_id: string | null } | null {
    return this.get('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?', tokenHash, now);
  }
  hasSession(tokenHash: string, now: number): boolean { return this.getSession(tokenHash, now) !== null; }

  addPushSub(endpoint: string, sub: string): void { this.run('INSERT OR REPLACE INTO push_subs (endpoint,sub) VALUES (?,?)', endpoint, sub); }
  removePushSub(endpoint: string): void { this.run('DELETE FROM push_subs WHERE endpoint=?', endpoint); }
  listPushSubs(): { endpoint: string; sub: string }[] { return this.all('SELECT endpoint, sub FROM push_subs ORDER BY rowid'); }

  createApproval(fromConv: string, toConv: string, prompt: string, onBehalf = ''): number {
    return Number(this.run('INSERT INTO approvals (from_conv,to_conv,prompt,on_behalf) VALUES (?,?,?,?)', fromConv, toConv, prompt, onBehalf).lastInsertRowid);
  }
  getApproval(id: number): Approval | null { return this.get('SELECT * FROM approvals WHERE id=?', id); }
  listApprovals(status: Approval['status']): Approval[] { return this.all('SELECT * FROM approvals WHERE status=? ORDER BY id', status); }
  setApprovalStatus(id: number, status: Approval['status']): void { this.run('UPDATE approvals SET status=? WHERE id=?', status, id); }

  private sealer: Sealer | null = null;
  private sealed = new Set<string>();

  /**
   * From now on the KV entries `keys` are stored encrypted with `sealer` (see secrets.ts). Those stored before in clear
   * are encrypted now, and the file is compacted so their old text does not linger in free pages. Throws when a stored
   * one was encrypted with another key (before anything is changed).
   */
  sealKv(sealer: Sealer, keys: string[]): { migrated: string[] } {
    const rows = keys.map((key) => ({ key, value: this.get<{ value: string }>('SELECT value FROM kv WHERE key=?', key)?.value ?? null }));
    for (const r of rows) if (r.value !== null) sealer.open(r.value);
    this.sealer = sealer;
    this.sealed = new Set(keys);
    const migrated = rows.filter((r) => r.value !== null && !Sealer.isSealed(r.value)).map((r) => r.key);
    for (const key of migrated) this.setKv(key, rows.find((r) => r.key === key)!.value!);
    if (migrated.length) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
    return { migrated };
  }

  getKv(key: string): string | null {
    const value = this.get<{ value: string }>('SELECT value FROM kv WHERE key=?', key)?.value ?? null;
    return value !== null && this.sealer && this.sealed.has(key) ? this.sealer.open(value) : value;
  }
  setKv(key: string, value: string): void {
    const stored = this.sealer && this.sealed.has(key) ? this.sealer.seal(value) : value;
    this.run('INSERT OR REPLACE INTO kv (key,value) VALUES (?,?)', key, stored);
  }
  deleteKv(key: string): void { this.run('DELETE FROM kv WHERE key=?', key); }
  // Global model/effort defaults are kept per backend: a Codex model name means nothing to Claude Code.
  private defaultKey(name: string, backend: Backend): string { return backend === 'claude' ? `${name}_claude` : name; }
  getDefaultModel(backend: Backend = 'codex'): string { return this.getKv(this.defaultKey('default_model', backend)) ?? ''; }
  setDefaultModel(model: string, backend: Backend = 'codex'): void { this.setKv(this.defaultKey('default_model', backend), model); }
  getDefaultEffort(backend: Backend = 'codex'): string { return this.getKv(this.defaultKey('default_effort', backend)) ?? ''; }
  setDefaultEffort(effort: string, backend: Backend = 'codex'): void { this.setKv(this.defaultKey('default_effort', backend), effort); }
  /** The models agents may pick for chats over MCP, weakest first; empty = agents keep the default. */
  getAgentModels(backend: Backend = 'codex'): string[] {
    try { return JSON.parse(this.getKv(this.defaultKey('agent_models', backend)) ?? '[]') as string[]; } catch { return []; }
  }
  setAgentModels(models: string[], backend: Backend = 'codex'): void { this.setKv(this.defaultKey('agent_models', backend), JSON.stringify(models)); }
  /** The highest reasoning effort agents may pick over MCP; empty = they keep the default. */
  getAgentMaxEffort(backend: Backend = 'codex'): string { return this.getKv(this.defaultKey('agent_max_effort', backend)) ?? ''; }
  setAgentMaxEffort(effort: string, backend: Backend = 'codex'): void { this.setKv(this.defaultKey('agent_max_effort', backend), effort); }
  getSubagentPolicy(): SubagentPolicy {
    try { return { ...SUBAGENT_DEFAULTS, ...(JSON.parse(this.getKv('subagents') ?? '{}') as Partial<SubagentPolicy>) }; } catch { return SUBAGENT_DEFAULTS; }
  }
  setSubagentPolicy(p: SubagentPolicy): void { this.setKv('subagents', JSON.stringify(p)); }
  /** Whether chat agents may commit and push themselves (see agent-git.ts); by default neither. */
  getAgentGit(): AgentGitPolicy {
    try { return { ...AGENT_GIT_DEFAULTS, ...(JSON.parse(this.getKv('agent_git') ?? '{}') as Partial<AgentGitPolicy>) }; } catch { return AGENT_GIT_DEFAULTS; }
  }
  setAgentGit(p: AgentGitPolicy): void { this.setKv('agent_git', JSON.stringify(p)); }
  getMemoryPolicy(): MemoryPolicy {
    try { return { ...MEMORY_DEFAULTS, ...(JSON.parse(this.getKv('memory') ?? '{}') as Partial<MemoryPolicy>) }; } catch { return MEMORY_DEFAULTS; }
  }
  setMemoryPolicy(p: MemoryPolicy): void { this.setKv('memory', JSON.stringify(p)); }

  createProject(name: string, path: string, sandbox = 'workspace-write', backend: Backend = 'codex', access: ProjectAccess = 'all'): Project {
    const p = { id: randomUUID(), name, path, sandbox, backend, access };
    this.run('INSERT INTO projects (id,name,path,sandbox,backend,access) VALUES (?,?,?,?,?,?)', p.id, name, path, sandbox, backend, access);
    return p;
  }
  setProjectAccess(id: string, access: ProjectAccess): boolean {
    return Number(this.run('UPDATE projects SET access=? WHERE id=?', access, id).changes) > 0;
  }
  listProjects(): Project[] { return this.all('SELECT * FROM projects ORDER BY name'); }
  getProject(id: string): Project | null { return this.get('SELECT * FROM projects WHERE id=?', id); }
  deleteConversation(id: string): boolean { return Number(this.run('DELETE FROM conversations WHERE id=?', id).changes) > 0; }
  deleteProject(id: string): boolean { return Number(this.run('DELETE FROM projects WHERE id=?', id).changes) > 0; }

  /** The chat runs on the project's backend unless told otherwise. */
  createConversation(projectId: string, backend?: Backend, parent = ''): Conversation {
    const id = randomUUID();
    backend ??= this.getProject(projectId)?.backend ?? 'codex';
    this.run('INSERT INTO conversations (id,project_id,thread_id,backend,parent) VALUES (?,?,NULL,?,?)', id, projectId, backend, parent);
    return this.getConversation(id)!;
  }
  listConversations(projectId: string): Conversation[] {
    return this.all(`SELECT c.*, ${TITLE} AS title FROM conversations c WHERE project_id=? ORDER BY c.rowid`, projectId);
  }
  /** The sub-agents a chat's agent started (that still exist). */
  countChildren(id: string): number { return this.get<{ n: number }>('SELECT count(*) AS n FROM conversations WHERE parent=?', id)!.n; }
  /** The sub-agents a chat's agent started, in any project. */
  listChildren(id: string): Conversation[] { return this.all(`SELECT c.*, ${TITLE} AS title FROM conversations c WHERE parent=? ORDER BY c.rowid`, id); }
  /** How many sub-agent levels a chat is below a chat a person started (0 for that one). */
  depthOf(id: string): number {
    let depth = 0;
    for (let c = this.getConversation(id); c?.parent && depth < 100; c = this.getConversation(c.parent)) depth++;
    return depth;
  }
  getConversation(id: string): Conversation | null { return this.get(`SELECT c.*, ${TITLE} AS title FROM conversations c WHERE id=?`, id); }
  setTitle(id: string, title: string): void { this.run('UPDATE conversations SET auto_title=? WHERE id=?', title, id); }
  setWorktree(id: string, w: { dir: string; branch: string; base: string | null }): void {
    this.run('UPDATE conversations SET worktree=?, branch=?, base_branch=? WHERE id=?', w.dir, w.branch, w.base, id);
  }
  setBranch(id: string, branch: string): void { this.run('UPDATE conversations SET branch=? WHERE id=?', branch, id); }
  setPrUrl(id: string, url: string, branch: string): void { this.run('UPDATE conversations SET pr_url=?, pr_branch=? WHERE id=?', url, branch, id); }
  setThread(id: string, threadId: string): void { this.run('UPDATE conversations SET thread_id=? WHERE id=?', threadId, id); }
  setStatus(id: string, status: Conversation['status']): void { this.run('UPDATE conversations SET status=? WHERE id=?', status, id); }
  setDraft(id: string, draft: string): void { this.run('UPDATE conversations SET draft=? WHERE id=?', draft, id); }
  setModel(id: string, model: string): void { this.run('UPDATE conversations SET model=? WHERE id=?', model, id); }
  setEffort(id: string, effort: string): void { this.run('UPDATE conversations SET effort=? WHERE id=?', effort, id); }
  enqueue(convId: string, prompt: string, attachments: string[], author = '', onBehalf = author, fromConv = ''): number {
    const r = this.run('INSERT INTO queue (conversation_id,prompt,attachments,author,on_behalf,from_conv) VALUES (?,?,?,?,?,?)',
      convId, prompt, JSON.stringify(attachments), author, onBehalf, fromConv);
    return Number(r.lastInsertRowid);
  }
  listQueue(convId: string): QueueItem[] {
    return this.all<QueueRow>('SELECT * FROM queue WHERE conversation_id=? ORDER BY id', convId).map(toItem);
  }
  /** The chat a queued prompt waits in, or null. */
  queueConversation(id: number): string | null {
    return this.get<{ conversation_id: string }>('SELECT conversation_id FROM queue WHERE id=?', id)?.conversation_id ?? null;
  }
  deleteQueueItem(id: number): boolean { return Number(this.run('DELETE FROM queue WHERE id=?', id).changes) > 0; }
  popQueue(convId: string): QueueItem | null {
    const row = this.get<QueueRow>('SELECT * FROM queue WHERE conversation_id=? ORDER BY id LIMIT 1', convId);
    if (!row) return null;
    this.run('DELETE FROM queue WHERE id=?', row.id);
    return toItem(row);
  }

  startTurn(convId: string, prompt: string): number {
    return Number(this.run('INSERT INTO turns (conversation_id,prompt) VALUES (?,?)', convId, prompt).lastInsertRowid);
  }
  endTurn(turnId: number, status: string, usage: unknown): void {
    this.run('UPDATE turns SET status=?, usage=?, ended_at=CURRENT_TIMESTAMP WHERE id=?', status, usage == null ? null : JSON.stringify(usage), turnId);
  }
  listTurns(convId: string): Turn[] { return this.all('SELECT * FROM turns WHERE conversation_id=? ORDER BY id', convId); }

  addEvent(turnId: number, type: string, payload: string): number {
    return Number(this.run('INSERT INTO events (turn_id,type,payload,created_at) VALUES (?,?,?,?)', turnId, type, payload, new Date().toISOString()).lastInsertRowid);
  }
  eventCreatedAt(id: number): string | null { return this.get<{ created_at: string }>('SELECT created_at FROM events WHERE id=?', id)?.created_at ?? null; }
  eventsAfter(convId: string, afterId: number): StoredEvent[] {
    return this.all(
      `SELECT e.id, t.conversation_id, e.type, e.payload, e.created_at FROM events e
       JOIN turns t ON t.id = e.turn_id
       WHERE t.conversation_id=? AND e.id>? ORDER BY e.id`, convId, afterId);
  }
  /** One event of a chat (null when it is not one of its). */
  eventOf(convId: string, id: number): StoredEvent | null {
    return this.get(
      `SELECT e.id, t.conversation_id, e.type, e.payload, e.created_at FROM events e
       JOIN turns t ON t.id = e.turn_id WHERE e.id=? AND t.conversation_id=?`, id, convId);
  }
  /**
   * A page of a chat's history in whole turns, so it folds into the thread on its own: the last `turns` turns before
   * turn `before` (the newest when not given), reaching back to the turn of event `focus` when that lies before them.
   * `first` is the page's first turn (the `before` of the page above it); `more` whether turns lie before it.
   */
  historyPage(convId: string, o: { turns: number; before?: number; focus?: number }): { events: StoredEvent[]; first: number | null; more: boolean } {
    const before = o.before ?? Number.MAX_SAFE_INTEGER;
    const ids = this.all<{ id: number }>('SELECT id FROM turns WHERE conversation_id=? AND id<? ORDER BY id DESC LIMIT ?', convId, before, o.turns);
    let first = ids.length ? ids[ids.length - 1]!.id : null;
    if (o.focus) {
      const at = this.get<{ turn_id: number }>('SELECT e.turn_id FROM events e JOIN turns t ON t.id = e.turn_id WHERE e.id=? AND t.conversation_id=?', o.focus, convId);
      if (at && at.turn_id < before && (first === null || at.turn_id < first)) first = at.turn_id;
    }
    if (first === null) return { events: [], first: null, more: false };
    const events = this.all<StoredEvent>(
      `SELECT e.id, t.conversation_id, e.type, e.payload, e.created_at FROM events e
       JOIN turns t ON t.id = e.turn_id
       WHERE t.conversation_id=? AND e.turn_id>=? AND e.turn_id<? ORDER BY e.id`, convId, first, before);
    const more = this.get('SELECT 1 FROM turns WHERE conversation_id=? AND id<? LIMIT 1', convId, first) !== null;
    return { events, first, more };
  }

  // --- project and personal memory (see memory.ts) ---
  /**
   * Whose personal memory a panel user's name stands for: their id, 'owner' for the owner, '' for nobody (an agent, an
   * approval) or a name no user has.
   */
  userKeyOf(name: string): string {
    if (name === 'owner') return 'owner';
    return name ? this.get<{ id: string }>('SELECT id FROM users WHERE name=?', name)?.id ?? '' : '';
  }
  /** One scope's memories, most recently changed first. */
  listMemories(scope: MemoryScope): Memory[] {
    const [where, arg] = scopeWhere(scope);
    return this.all(`SELECT * FROM memories WHERE ${where} ORDER BY updated_at DESC, id DESC`, arg);
  }
  /** Memories containing every term (case-insensitive for ASCII letters), most recently changed first. */
  searchMemories(scope: MemoryScope, terms: string[]): Memory[] {
    const [where, arg] = scopeWhere(scope);
    const like = terms.map(() => "text LIKE ? ESCAPE '\\'").join(' AND ');
    return this.all(`SELECT * FROM memories WHERE ${where}${terms.length ? ` AND ${like}` : ''} ORDER BY updated_at DESC, id DESC`,
      arg, ...terms.map(likeTerm));
  }
  getMemory(id: number): Memory | null { return this.get('SELECT * FROM memories WHERE id=?', id); }
  addMemory(scope: MemoryScope, text: string, from: { conv?: string; title?: string; by?: string } = {}): Memory {
    const now = new Date().toISOString();
    const r = this.run('INSERT INTO memories (project_id,user_key,text,source_conv,source_title,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      'projectId' in scope ? scope.projectId : null, 'userKey' in scope ? scope.userKey : '', text, from.conv ?? '', from.title ?? '', from.by ?? '', now, now);
    return this.getMemory(Number(r.lastInsertRowid))!;
  }
  updateMemory(id: number, text: string): boolean {
    return Number(this.run('UPDATE memories SET text=?, updated_at=? WHERE id=?', text, new Date().toISOString(), id).changes) > 0;
  }
  deleteMemory(id: number): boolean { return Number(this.run('DELETE FROM memories WHERE id=?', id).changes) > 0; }
  /**
   * One scope's memories that contain any of `terms` (lowercased words; each also matches as the start of a longer
   * one), best match first (BM25), at most `limit`.
   */
  matchMemories(scope: MemoryScope, terms: string[], limit = 50): Memory[] {
    if (!terms.length) return [];
    if (this.fts) {
      const query = terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
      const [where, arg] = scopeWhere(scope);
      return this.all(`SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
        WHERE memories_fts MATCH ? AND m.${where} ORDER BY bm25(memories_fts) LIMIT ?`, query, arg, limit);
    }
    const scored = this.listMemories(scope).map((m) => {
      const words = m.text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
      return { m, n: terms.filter((t) => words.some((w) => w.startsWith(t))).length };
    });
    return scored.filter((s) => s.n).sort((a, b) => b.n - a.n).slice(0, limit).map((s) => s.m);
  }

  // --- scheduled prompts ---
  createSchedule(convId: string, s: { prompt: string; cron: string; enabled: boolean; nextRunAt: number | null; createdBy: string }): Schedule {
    const r = this.run('INSERT INTO schedules (conversation_id,prompt,cron,enabled,next_run_at,created_by) VALUES (?,?,?,?,?,?)',
      convId, s.prompt, s.cron, s.enabled ? 1 : 0, s.enabled ? s.nextRunAt : null, s.createdBy);
    return this.getSchedule(Number(r.lastInsertRowid))!;
  }
  getSchedule(id: number): Schedule | null {
    const r = this.get<ScheduleRow>('SELECT * FROM schedules WHERE id=?', id);
    return r && toSchedule(r);
  }
  /** One chat's schedules, or every schedule when `convId` is omitted; with the project and chat names. */
  listSchedules(convId?: string): ScheduleSummary[] {
    const rows = this.db.prepare(`SELECT s.*, c.project_id, p.name AS project, ${TITLE} AS title FROM schedules s
      JOIN conversations c ON c.id = s.conversation_id JOIN projects p ON p.id = c.project_id
      WHERE ? IS NULL OR s.conversation_id = ? ORDER BY p.name, s.id`).all(convId ?? null, convId ?? null) as unknown as (ScheduleRow & Omit<ScheduleSummary, keyof Schedule>)[];
    return rows.map(toSchedule);
  }
  updateSchedule(id: number, s: { prompt: string; cron: string; enabled: boolean; nextRunAt: number | null }): void {
    this.run('UPDATE schedules SET prompt=?, cron=?, enabled=?, next_run_at=? WHERE id=?', s.prompt, s.cron, s.enabled ? 1 : 0, s.enabled ? s.nextRunAt : null, id);
  }
  deleteSchedule(id: number): boolean { return Number(this.run('DELETE FROM schedules WHERE id=?', id).changes) > 0; }
  /** Enabled schedules whose next run is due at `now`. */
  dueSchedules(now: number): Schedule[] {
    return this.all<ScheduleRow>('SELECT * FROM schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at', now).map(toSchedule);
  }
  /** Record a run; `nextRunAt` null switches the schedule off (it would never fire again). */
  markScheduleRun(id: number, at: number, nextRunAt: number | null): void {
    this.run('UPDATE schedules SET last_run_at=?, next_run_at=?, enabled=CASE WHEN ? IS NULL THEN 0 ELSE enabled END WHERE id=?', at, nextRunAt, nextRunAt, id);
  }

  /**
   * Chats whose title, prompts or agent answers contain every term (case-insensitive for ASCII letters), newest first.
   * Only what a person reads is searched: commands, their output and tool calls are not.
   */
  search(terms: string[], o: { projectId?: string; limit?: number } = {}): SearchHit[] {
    const limit = o.limit ?? 50;
    const project = o.projectId ?? null;
    const likes = terms.map(likeTerm);
    const all = (col: string) => terms.map(() => `${col} LIKE ? ESCAPE '\\'`).join(' AND ');
    // Generated titles only: without one, the title is the first prompt, which the events below already cover.
    const titles = this.db.prepare(`SELECT 'title' AS kind, c.id AS conversation_id, c.project_id, p.name AS project,
        c.auto_title AS title, NULL AS event_id, NULL AS created_at FROM conversations c JOIN projects p ON p.id = c.project_id
        WHERE (? IS NULL OR c.project_id = ?) AND c.auto_title IS NOT NULL AND ${all('c.auto_title')} ORDER BY p.name, c.auto_title LIMIT ?`)
      .all(project, project, ...likes, limit) as unknown as SearchHit[];
    // The events that hold text: what was asked (user.prompt) and what the agent answered (an agent_message item).
    const events = this.db.prepare(`SELECT * FROM (SELECT
        CASE e.type WHEN 'user.prompt' THEN 'prompt' ELSE 'answer' END AS kind,
        t.conversation_id, c.project_id, p.name AS project, e.id AS event_id, e.created_at,
        CASE e.type WHEN 'user.prompt' THEN json_extract(e.payload, '$.text') ELSE json_extract(e.payload, '$.item.text') END AS text
      FROM events e JOIN turns t ON t.id = e.turn_id JOIN conversations c ON c.id = t.conversation_id JOIN projects p ON p.id = c.project_id
      WHERE (? IS NULL OR c.project_id = ?)
        AND (e.type = 'user.prompt' OR (e.type = 'item.completed' AND e.payload LIKE '%"agent_message"%'))
        AND json_valid(e.payload)
        AND (e.type = 'user.prompt' OR json_extract(e.payload, '$.item.type') = 'agent_message'))
      WHERE typeof(text) = 'text' AND ${all('text')} ORDER BY event_id DESC LIMIT ?`)
      .all(project, project, ...likes, limit) as unknown as SearchHit[];
    const titleOf = new Map(titles.map((t) => [t.conversation_id, t.title]));
    for (const e of events) {
      if (!titleOf.has(e.conversation_id)) titleOf.set(e.conversation_id, this.getConversation(e.conversation_id)?.title ?? null);
      e.title = titleOf.get(e.conversation_id) ?? null;
    }
    return [...titles.map((t) => ({ ...t, text: t.title ?? '' })), ...events].slice(0, limit);
  }

  /** Mark rows left `running` by a crash as failed; return conversations that still have queued prompts. */
  resetRunning(): string[] {
    // Close each stale turn in the event stream too, or a replaying client would show it as still live.
    this.run(`INSERT INTO events (turn_id,type,payload,created_at) SELECT id, 'turn.failed',
      '{"type":"turn.failed","error":{"message":"gateway restarted while this turn was running"}}', ?
      FROM turns WHERE status='running'`, new Date().toISOString());
    this.run(`UPDATE turns SET status='failed', ended_at=CURRENT_TIMESTAMP WHERE status='running'`);
    this.run(`UPDATE conversations SET status='failed' WHERE status='running'`);
    return this.all<{ conversation_id: string }>('SELECT DISTINCT conversation_id FROM queue').map((r) => r.conversation_id);
  }
}
