import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Backend } from './util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
  sandbox TEXT NOT NULL DEFAULT 'workspace-write', backend TEXT NOT NULL DEFAULT 'codex');
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
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, from_conv TEXT NOT NULL, to_conv TEXT NOT NULL,
  prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`;

export interface Approval {
  id: number; from_conv: string; to_conv: string; prompt: string;
  status: 'pending' | 'approved' | 'rejected'; created_at: string;
}

/** `userId` null means the owner (the person holding the main token); otherwise the panel user who registered it. */
export interface Passkey { id: string; publicKey: Uint8Array<ArrayBuffer>; counter: number; transports?: string[]; userId?: string | null }

export type Role = 'admin' | 'dev';
export interface User { id: string; name: string; role: Role; created_at: string }
export interface UserSummary { id: string; name: string; role: Role; createdAt: string; passkeys: number }

/** `backend` is the agent CLI every chat in the project runs on. */
export interface Project { id: string; name: string; path: string; sandbox: string; backend: Backend }
export interface Conversation {
  id: string; project_id: string; thread_id: string | null;
  /** First prompt of the chat (list only), for display. */
  title?: string | null;
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
}
export interface QueueItem { id: number; conversation_id: string; prompt: string; attachments: string[] }
export interface Turn {
  id: number; conversation_id: string; prompt: string; status: string;
  usage: string | null; started_at: string; ended_at: string | null;
}
export interface StoredEvent { id: number; conversation_id: string; type: string; payload: string; created_at: string }

interface QueueRow { id: number; conversation_id: string; prompt: string; attachments: string }
const toItem = (r: QueueRow): QueueItem => ({ ...r, attachments: JSON.parse(r.attachments) as string[] });

export class Store {
  readonly db: DatabaseSync;

  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    // Databases made by earlier versions lack these columns; CREATE TABLE IF NOT EXISTS does not add them.
    this.ensureColumn('sessions', 'user_id', 'TEXT REFERENCES users(id) ON DELETE CASCADE');
    this.ensureColumn('passkeys', 'user_id', 'TEXT REFERENCES users(id) ON DELETE CASCADE');
    this.ensureColumn('conversations', 'model', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('conversations', 'effort', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('projects', 'backend', "TEXT NOT NULL DEFAULT 'codex'");
    this.ensureColumn('conversations', 'backend', "TEXT NOT NULL DEFAULT 'codex'");
    this.ensureColumn('events', 'created_at', 'TEXT');
    this.ensureColumn('conversations', 'worktree', 'TEXT');
    this.ensureColumn('conversations', 'branch', 'TEXT');
    this.ensureColumn('conversations', 'base_branch', 'TEXT');
    this.run(`UPDATE events SET created_at=(SELECT started_at FROM turns WHERE turns.id=events.turn_id) WHERE created_at IS NULL`);
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

  // --- passkeys, login sessions, push subscriptions, small key/value settings ---
  addPasskey(p: Passkey, userId: string | null = null): void {
    this.run('INSERT OR REPLACE INTO passkeys (id,public_key,counter,transports,user_id) VALUES (?,?,?,?,?)',
      p.id, p.publicKey, p.counter, p.transports ? JSON.stringify(p.transports) : null, userId);
  }
  private toPasskey(r: { id: string; public_key: Uint8Array; counter: number; transports: string | null; user_id: string | null }): Passkey {
    return {
      id: r.id, publicKey: new Uint8Array(r.public_key), counter: r.counter,
      transports: r.transports ? JSON.parse(r.transports) : undefined, userId: r.user_id,
    };
  }
  /** All passkeys, or only one owner's when `userId` is given (null = the owner / main-token holder). */
  listPasskeys(userId?: string | null): Passkey[] {
    const rows = userId === undefined
      ? this.all<any>('SELECT * FROM passkeys ORDER BY rowid')
      : this.db.prepare('SELECT * FROM passkeys WHERE user_id IS ? ORDER BY rowid').all(userId) as unknown as any[];
    return rows.map((r) => this.toPasskey(r));
  }

  // --- panel users (role admin or dev); the personal token is stored only as a hash ---
  createUser(name: string, role: Role, tokenHash: string): User {
    const id = randomUUID();
    this.run('INSERT INTO users (id,name,role,token_hash) VALUES (?,?,?,?)', id, name, role, tokenHash);
    return this.getUser(id)!;
  }
  getUser(id: string): User | null { return this.get('SELECT id,name,role,created_at FROM users WHERE id=?', id); }
  getUserByTokenHash(hash: string): User | null { return this.get('SELECT id,name,role,created_at FROM users WHERE token_hash=?', hash); }
  listUsers(): UserSummary[] {
    return this.all(`SELECT u.id, u.name, u.role, u.created_at AS createdAt,
      (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys FROM users u ORDER BY u.rowid`);
  }
  setUserRole(id: string, role: Role): boolean { return Number(this.run('UPDATE users SET role=? WHERE id=?', role, id).changes) > 0; }
  /** New token for a user; their old token and every open session stop working. */
  setUserToken(id: string, tokenHash: string): boolean {
    const changed = Number(this.run('UPDATE users SET token_hash=? WHERE id=?', tokenHash, id).changes) > 0;
    if (changed) this.run('DELETE FROM sessions WHERE user_id=?', id);
    return changed;
  }
  deleteUser(id: string): boolean { return Number(this.run('DELETE FROM users WHERE id=?', id).changes) > 0; }
  getPasskey(id: string): Passkey | null {
    const r = this.get<any>('SELECT * FROM passkeys WHERE id=?', id);
    return r ? this.toPasskey(r) : null;
  }
  setPasskeyCounter(id: string, counter: number): void { this.run('UPDATE passkeys SET counter=? WHERE id=?', counter, id); }

  /** `userId` null = a session of the owner (passkey login without a panel user). */
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

  createApproval(fromConv: string, toConv: string, prompt: string): number {
    return Number(this.run('INSERT INTO approvals (from_conv,to_conv,prompt) VALUES (?,?,?)', fromConv, toConv, prompt).lastInsertRowid);
  }
  getApproval(id: number): Approval | null { return this.get('SELECT * FROM approvals WHERE id=?', id); }
  listApprovals(status: Approval['status']): Approval[] { return this.all('SELECT * FROM approvals WHERE status=? ORDER BY id', status); }
  setApprovalStatus(id: number, status: Approval['status']): void { this.run('UPDATE approvals SET status=? WHERE id=?', status, id); }

  getKv(key: string): string | null { return this.get<{ value: string }>('SELECT value FROM kv WHERE key=?', key)?.value ?? null; }
  setKv(key: string, value: string): void { this.run('INSERT OR REPLACE INTO kv (key,value) VALUES (?,?)', key, value); }
  // Global model/effort defaults are kept per backend: a Codex model name means nothing to Claude Code.
  private defaultKey(name: string, backend: Backend): string { return backend === 'claude' ? `${name}_claude` : name; }
  getDefaultModel(backend: Backend = 'codex'): string { return this.getKv(this.defaultKey('default_model', backend)) ?? ''; }
  setDefaultModel(model: string, backend: Backend = 'codex'): void { this.setKv(this.defaultKey('default_model', backend), model); }
  getDefaultEffort(backend: Backend = 'codex'): string { return this.getKv(this.defaultKey('default_effort', backend)) ?? ''; }
  setDefaultEffort(effort: string, backend: Backend = 'codex'): void { this.setKv(this.defaultKey('default_effort', backend), effort); }

  createProject(name: string, path: string, sandbox = 'workspace-write', backend: Backend = 'codex'): Project {
    const p = { id: randomUUID(), name, path, sandbox, backend };
    this.run('INSERT INTO projects (id,name,path,sandbox,backend) VALUES (?,?,?,?,?)', p.id, name, path, sandbox, backend);
    return p;
  }
  listProjects(): Project[] { return this.all('SELECT * FROM projects ORDER BY name'); }
  getProject(id: string): Project | null { return this.get('SELECT * FROM projects WHERE id=?', id); }
  deleteConversation(id: string): boolean { return Number(this.run('DELETE FROM conversations WHERE id=?', id).changes) > 0; }
  deleteProject(id: string): boolean { return Number(this.run('DELETE FROM projects WHERE id=?', id).changes) > 0; }

  /** `threadId` adopts an existing Codex session instead of starting a new one. The chat runs on the project's backend unless told otherwise. */
  createConversation(projectId: string, threadId: string | null = null, backend?: Backend): Conversation {
    const id = randomUUID();
    backend ??= this.getProject(projectId)?.backend ?? 'codex';
    this.run('INSERT INTO conversations (id,project_id,thread_id,backend) VALUES (?,?,?,?)', id, projectId, threadId, backend);
    return this.getConversation(id)!;
  }
  listConversations(projectId: string): Conversation[] {
    return this.all('SELECT c.*, (SELECT substr(prompt, 1, 80) FROM turns t WHERE t.conversation_id=c.id ORDER BY t.id LIMIT 1) AS title FROM conversations c WHERE project_id=? ORDER BY c.rowid', projectId);
  }
  getConversation(id: string): Conversation | null { return this.get('SELECT * FROM conversations WHERE id=?', id); }
  setWorktree(id: string, w: { dir: string; branch: string; base: string | null }): void {
    this.run('UPDATE conversations SET worktree=?, branch=?, base_branch=? WHERE id=?', w.dir, w.branch, w.base, id);
  }
  setThread(id: string, threadId: string): void { this.run('UPDATE conversations SET thread_id=? WHERE id=?', threadId, id); }
  setStatus(id: string, status: Conversation['status']): void { this.run('UPDATE conversations SET status=? WHERE id=?', status, id); }
  setDraft(id: string, draft: string): void { this.run('UPDATE conversations SET draft=? WHERE id=?', draft, id); }
  setModel(id: string, model: string): void { this.run('UPDATE conversations SET model=? WHERE id=?', model, id); }
  setEffort(id: string, effort: string): void { this.run('UPDATE conversations SET effort=? WHERE id=?', effort, id); }
  enqueue(convId: string, prompt: string, attachments: string[]): number {
    const r = this.run('INSERT INTO queue (conversation_id,prompt,attachments) VALUES (?,?,?)', convId, prompt, JSON.stringify(attachments));
    return Number(r.lastInsertRowid);
  }
  listQueue(convId: string): QueueItem[] {
    return this.all<QueueRow>('SELECT * FROM queue WHERE conversation_id=? ORDER BY id', convId).map(toItem);
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
