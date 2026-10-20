/**
 * Code memory: codebase-memory-mcp (CBM, github.com/DeusData/codebase-memory-mcp) keeps a graph of each project's code
 * (symbols, calls, imports, routes) that agents query instead of grepping file by file.
 *
 * Dalang owns it, so the agents never run CBM themselves: one long-lived CBM session for the whole server, each
 * project indexed only when someone asks for it (Settings → MCP → Code memory → Index), and CBM's query tools passed on
 * through this gateway's /mcp with the project taken from the chat. That keeps a chat to
 * its own project and the projects its user may open: CBM itself would show every indexed repository to anyone.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodTypeAny } from 'zod';
import { git, isRepo } from './git.js';
import type { Project, Store } from './store.js';
import type { Backend } from './util.js';

/**
 * What Settings → MCP → Code memory saves (kv `code_memory`). Empty dirs leave CBM's own defaults. `hooks`: turns also
 * get graph context next to their own searches (see CodeMemory.hooks).
 */
export interface CodeMemorySettings { enabled: boolean; command: string; cacheDir: string; runtimeDir: string; hooks: boolean }

/** One project's index (kv `code_memory:<project id>`). `graph` is CBM's name for it, known after the first index. */
export interface IndexState {
  status: 'indexing' | 'ready' | 'failed';
  graph: string; nodes: number; edges: number;
  /** When the last index finished (ms), and the git state it saw (null: not a git repository). */
  indexedAt: number; fingerprint: string | null;
  error: string;
}

export interface CbmTool { name: string; description?: string; inputSchema: JsonSchema }
export type CbmResult = CallToolResult;
/** A CBM session: the real one talks to the binary over stdio; tests pass a fake. */
export interface CbmClient {
  listTools(): Promise<CbmTool[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<CbmResult>;
  close(): Promise<void>;
  onClose?: () => void;
}
type JsonSchema = {
  type?: string | string[]; description?: string; enum?: unknown[]; items?: JsonSchema;
  properties?: Record<string, JsonSchema>; required?: string[];
};

const KEY = 'code_memory';
const stateKey = (projectId: string) => `${KEY}:${projectId}`;
/** Graphs of deleted projects CBM could not delete yet (see CodeMemory.dropGraph). */
const ORPHANS_KEY = 'code_memory_orphans';
const EMPTY: CodeMemorySettings = { enabled: false, command: '', cacheDir: '', runtimeDir: '', hooks: true };
/** The hook Claude Code runs (scripts/, next to src/ and dist/), with the node running Dalang. */
const HOOK_SCRIPT = fileURLToPath(new URL('../scripts/code-memory-hook.mjs', import.meta.url));
const HOOK_TIMEOUT_S = 5;

/**
 * The CBM tools a chat gets, as `code_<name>`. Left out: indexing and deleting (Dalang does those), listing or comparing
 * other repositories, recording traces, and detect_changes (it reads the project folder's git state, which is not what
 * a chat in its own worktree changed).
 */
export const CODE_TOOLS = [
  'search_graph', 'trace_path', 'get_code_snippet', 'get_file_outline', 'query_graph', 'get_architecture',
  'search_code', 'get_graph_schema', 'index_status', 'check_index_coverage', 'manage_adr',
];

const QUERY_TIMEOUT_MS = 60_000;
const INDEX_TIMEOUT_MS = 30 * 60_000;

const slash = (p: string) => p.replace(/\\/g, '/');

/** Whether a folder brings Codex hooks of its own (`.codex/hooks.json`, or hooks in `.codex/config.toml`). */
function hasCodexHooks(dir: string): boolean {
  if (existsSync(join(dir, '.codex', 'hooks.json'))) return true;
  try { return /^\s*\[*\s*hooks\b/m.test(readFileSync(join(dir, '.codex', 'config.toml'), 'utf8')); } catch { return false; }
}

/** CBM's folders, for every CBM process: all of them must agree on the cache, or CBM refuses to start. */
function cbmEnv(s: CodeMemorySettings): Record<string, string> {
  return { ...(s.cacheDir && { CBM_CACHE_DIR: s.cacheDir }), ...(s.runtimeDir && { CBM_RUNTIME_DIR: s.runtimeDir }) };
}

/** The CBM session over stdio. Its folder is Dalang's state dir, so CBM never watches or auto-indexes a project itself. */
export async function connectCbm(s: CodeMemorySettings, cwd: string): Promise<CbmClient> {
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...cbmEnv(s) };
  const transport = new StdioClientTransport({ command: s.command, args: [], env, cwd, stderr: 'ignore' });
  const client = new Client({ name: 'dalang', version: '0.1.0' });
  await client.connect(transport);
  const c: CbmClient = {
    listTools: async () => (await client.listTools()).tools as CbmTool[],
    callTool: async (name, args, timeoutMs) => (await client.callTool({ name, arguments: args }, undefined, {
      timeout: timeoutMs, resetTimeoutOnProgress: true,
    })) as CbmResult,
    close: () => client.close(),
  };
  client.onclose = () => c.onClose?.();
  return c;
}

/** `command --version`, to check the binary in the panel. */
export function cbmVersion(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, ['--version'], { timeout: 15_000 }, (err, out, stderr) => {
      if (err) reject(new Error((String(stderr).trim() || err.message).slice(-500)));
      else resolve(String(out).trim());
    });
  });
}

/** What git says the folder is now: HEAD plus the uncommitted changes. null outside a git repository. */
async function fingerprint(dir: string): Promise<string | null> {
  if (!(await isRepo(dir))) return null;
  const [head, status] = await Promise.all([
    git(dir, ['rev-parse', 'HEAD']).catch(() => ''), git(dir, ['status', '--porcelain=v1', '-z'], 120_000),
  ]);
  return createHash('sha1').update(head).update('\0').update(status).digest('hex');
}

/** A JSON Schema property of a CBM tool as zod, loosely: CBM checks ranges and fills in defaults itself. */
function zodOf(s: JsonSchema): ZodTypeAny {
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  let t: ZodTypeAny;
  if (s.enum?.length && s.enum.every((v) => typeof v === 'string')) t = z.enum(s.enum as [string, ...string[]]);
  else if (type === 'string') t = z.string();
  else if (type === 'integer') t = z.number().int();
  else if (type === 'number') t = z.number();
  else if (type === 'boolean') t = z.boolean();
  else if (type === 'array') t = z.array(s.items ? zodOf(s.items) : z.any());
  else if (type === 'object' && s.properties) t = z.object(shapeOf(s)).passthrough();
  else if (type === 'object') t = z.record(z.string(), z.any());
  else t = z.any();
  return s.description ? t.describe(s.description) : t;
}

/** A CBM tool's arguments as a zod shape, without `project`: the gateway fills that in. */
export function shapeOf(s: JsonSchema, drop: string[] = []): Record<string, ZodTypeAny> {
  const required = new Set(s.required ?? []);
  return Object.fromEntries(Object.entries(s.properties ?? {}).filter(([k]) => !drop.includes(k))
    .map(([k, v]) => [k, required.has(k) ? zodOf(v) : zodOf(v).optional()]));
}

/** The first text of a CBM answer as JSON, or null. */
function resultJson(r: CbmResult): Record<string, unknown> | null {
  const first = r.content.find((c) => c.type === 'text');
  try { return first ? JSON.parse(first.text) : null; } catch { return null; }
}
const resultText = (r: CbmResult) => r.content.map((c) => (c as { text?: string }).text ?? '').join('\n').trim();

export class CodeMemory {
  private client: Promise<CbmClient> | null = null;
  private toolList: CbmTool[] = [];
  /** Per project: the index running now, and whether another one is wanted once it ends. */
  private running = new Map<string, Promise<void>>();
  private again = new Set<string>();
  /** Indexing runs one project at a time, so asking for several at once does not take every core. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private store: Store, private opts: {
    /** CBM's working folder (Dalang's state dir). */
    cwd: string;
    connect?: (s: CodeMemorySettings, cwd: string) => Promise<CbmClient>;
  }) {}

  settings(): CodeMemorySettings {
    try {
      const s = { ...EMPTY, ...JSON.parse(this.store.getKv(KEY) ?? '{}') };
      return {
        enabled: s.enabled === true, command: String(s.command), cacheDir: String(s.cacheDir), runtimeDir: String(s.runtimeDir),
        hooks: s.hooks !== false,
      };
    } catch { return EMPTY; }
  }

  /** Save the settings; a new binary or folder starts a new CBM session (indexing nothing: that is asked per project). */
  async save(s: CodeMemorySettings): Promise<void> {
    this.store.setKv(KEY, JSON.stringify(s));
    await this.disconnect();
    if (s.enabled) await this.connection().catch(() => {}); // reads the tool list, so chats get the tools
  }

  /** Whether chats get the tools: on, with a binary, and its tool list read. */
  get active(): boolean { return this.settings().enabled && this.toolList.length > 0; }

  state(projectId: string): IndexState | null {
    try { return JSON.parse(this.store.getKv(stateKey(projectId)) ?? 'null'); } catch { return null; }
  }
  private setState(projectId: string, s: IndexState): void { this.store.setKv(stateKey(projectId), JSON.stringify(s)); }

  private connection(): Promise<CbmClient> {
    const s = this.settings();
    if (!s.enabled || !s.command) return Promise.reject(new Error('code memory is off'));
    if (!this.client) {
      const p = (this.opts.connect ?? connectCbm)(s, this.opts.cwd).then(async (c) => {
        c.onClose = () => { if (this.client === p) this.client = null; }; // CBM exited: the next call starts it again
        this.toolList = (await c.listTools()).filter((t) => CODE_TOOLS.includes(t.name));
        void this.dropOrphans(c);
        return c;
      });
      p.catch(() => { if (this.client === p) this.client = null; });
      this.client = p;
    }
    return this.client;
  }

  private async disconnect(): Promise<void> {
    const p = this.client;
    this.client = null;
    this.toolList = [];
    if (p) await p.then((c) => c.close()).catch(() => {});
  }

  /** The CBM tools chats get (empty until the first session is up). */
  tools(): CbmTool[] { return this.toolList; }

  /** Run a CBM query tool on a project's graph. */
  async query(project: Project, tool: string, args: Record<string, unknown>): Promise<CbmResult> {
    if (!CODE_TOOLS.includes(tool)) throw new Error(`no such code memory tool: ${tool}`);
    const st = this.state(project.id);
    if (!st?.graph) {
      throw new Error(`project "${project.name}" has no code graph yet (the owner indexes it in Settings → MCP → Code memory); use grep and file reads`);
    }
    const c = await this.connection();
    return c.callTool(tool, { ...args, project: st.graph }, QUERY_TIMEOUT_MS);
  }

  /** Index `project` now (or once the index running for it ends). Resolves when its index is up to date. */
  index(project: Project): Promise<void> {
    const cur = this.running.get(project.id);
    if (cur) { this.again.add(project.id); return cur; }
    const run = (async () => {
      do {
        this.again.delete(project.id);
        const job = this.queue.then(() => this.indexOnce(project));
        this.queue = job.catch(() => {});
        await job;
      } while (this.again.has(project.id));
    })().finally(() => this.running.delete(project.id));
    this.running.set(project.id, run);
    return run;
  }

  private async indexOnce(project: Project): Promise<void> {
    if (!this.store.getProject(project.id)) return; // deleted while queued
    const prev = this.state(project.id);
    const base: IndexState = prev ?? { status: 'indexing', graph: '', nodes: 0, edges: 0, indexedAt: 0, fingerprint: null, error: '' };
    if (!existsSync(project.path)) {
      this.setState(project.id, { ...base, status: 'failed', error: `folder not found: ${project.path}` });
      return;
    }
    this.setState(project.id, { ...base, status: 'indexing', error: '' });
    // A project deleted while its index ran was forgotten meanwhile (see forget): its state stays gone, and the graph
    // the index just built goes too.
    const gone = () => !this.store.getProject(project.id);
    try {
      const fp = await fingerprint(project.path).catch(() => null);
      const c = await this.connection();
      const r = await c.callTool('index_repository', { repo_path: project.path }, INDEX_TIMEOUT_MS);
      const j = resultJson(r);
      if (r.isError || !j || typeof j.project !== 'string') throw new Error(resultText(r).slice(0, 1000) || 'CBM gave no answer');
      if (gone()) { await this.dropGraph(j.project); return; }
      this.setState(project.id, {
        status: 'ready', graph: j.project, nodes: Number(j.nodes) || 0, edges: Number(j.edges) || 0,
        indexedAt: Date.now(), fingerprint: fp, error: '',
      });
    } catch (e) {
      if (gone()) return;
      this.setState(project.id, { ...base, status: 'failed', error: (e as Error).message.slice(0, 1000) });
    }
  }

  /**
   * Whether the project's files changed since its last index (its git HEAD or uncommitted changes differ), so the
   * panel can say an index is out of date. null when unknown: no index yet, or not a git repository.
   */
  async changedSinceIndex(project: Project): Promise<boolean | null> {
    const st = this.state(project.id);
    if (!st?.graph || st.fingerprint === null) return null;
    const fp = await fingerprint(project.path).catch(() => null);
    return fp === null ? null : fp !== st.fingerprint;
  }

  /** Forget a deleted project's graph. */
  async forget(project: Project): Promise<void> {
    const st = this.state(project.id);
    this.store.deleteKv(stateKey(project.id));
    if (st?.graph) await this.dropGraph(st.graph);
  }

  private orphans(): string[] {
    try { return JSON.parse(this.store.getKv(ORPHANS_KEY) ?? '[]'); } catch { return []; }
  }
  private setOrphans(graphs: string[]): void {
    if (graphs.length) this.store.setKv(ORPHANS_KEY, JSON.stringify(graphs)); else this.store.deleteKv(ORPHANS_KEY);
  }

  /**
   * Delete a graph from CBM unless a project still uses it (another project on the same folder shares it). One CBM
   * cannot delete now (code memory off, the binary gone) is kept and deleted when the next CBM session starts.
   */
  private async dropGraph(graph: string): Promise<void> {
    if (this.store.listProjects().some((p) => this.state(p.id)?.graph === graph)) return;
    try {
      await (await this.connection()).callTool('delete_project', { project: graph }, QUERY_TIMEOUT_MS);
      this.setOrphans(this.orphans().filter((g) => g !== graph));
    } catch {
      this.setOrphans([...new Set([...this.orphans(), graph])]);
    }
  }

  /** Delete the graphs left behind while CBM could not be asked (see dropGraph), on a new CBM session. */
  private async dropOrphans(c: CbmClient): Promise<void> {
    for (const graph of this.orphans()) {
      if (this.store.listProjects().some((p) => this.state(p.id)?.graph === graph)) { this.setOrphans(this.orphans().filter((g) => g !== graph)); continue; }
      try {
        await c.callTool('delete_project', { project: graph }, QUERY_TIMEOUT_MS);
        this.setOrphans(this.orphans().filter((g) => g !== graph));
      } catch { return; } // CBM went away again: the next session tries again
    }
  }

  /**
   * What a turn is told: that this project has a graph and how to reach it. Empty while code memory is off or the
   * project has no index yet.
   */
  guide(project: Project, worktree: boolean): string {
    const st = this.state(project.id);
    if (!this.active || !st?.graph) return '';
    return `Code memory: this project's code is indexed as a graph (symbols, calls, imports, routes), last on
${new Date(st.indexedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC: code changed since is not in it. Ask the graph FIRST,
before any grep, glob or reading files one by one, whenever you look for code by what it is rather than by its exact text:
- where a function, class, method, route or variable is defined: code_search_graph
- who calls it, what it calls, what a change to it affects: code_trace_path
- its source, once found: code_get_code_snippet (or code_get_file_outline for a whole file)
- how the project or a part of it is put together: code_get_architecture; anything multi-hop: code_query_graph
These are dalang MCP tools (in Claude Code they may need loading first: search your tools for "mcp__dalang__code"). They
work on this chat's project; leave project_id out. Grep only for literal text (strings, messages, config keys), when the
graph has no answer, or for code newer than the index. Read a file before you change it.`
      + (worktree ? `\nThe graph is of the project's main folder, not of your worktree: for files you changed yourself, read them.` : '');
  }

  /**
   * Hooks for a turn that put the graph symbols matching each search next to the tool's own result, through
   * scripts/code-memory-hook.mjs and CBM's `hook-augment`. They read only this project's graph (the hook gets the
   * project folder, never the turn's own) and fail open. null when off or the project has no index yet.
   *
   * Claude Code: `--settings` hooks before Grep, Glob and Bash, and after Read (what the graph could not parse there).
   * Codex: an inline `-c hooks.PreToolUse` hook before its shell commands (Bash: rg, grep, ...), which needs
   * `--dangerously-bypass-hook-trust` since nothing can trust it headless. That flag runs every enabled hook unreviewed,
   * so a turn whose folder brings Codex hooks of its own (a repository's `.codex/`) gets none from us, and theirs stay
   * as untrusted as before.
   */
  hooks(project: Project, backend: Backend, cwd: string): { args: string[]; env: Record<string, string> } | null {
    const s = this.settings();
    if (!this.active || !s.hooks || !this.state(project.id)?.graph) return null;
    const env = { ...cbmEnv(s), LZVR_CBM_COMMAND: s.command, LZVR_CODE_ROOT: project.path };
    if (backend === 'claude') {
      const q = (p: string) => `"${slash(p)}"`;
      const hook = [{ type: 'command', command: `${q(process.execPath)} ${q(HOOK_SCRIPT)}`, timeout: HOOK_TIMEOUT_S }];
      const settings = { hooks: { PreToolUse: [{ matcher: 'Grep|Glob|Bash', hooks: hook }], PostToolUse: [{ matcher: 'Read', hooks: hook }] } };
      return { args: ['--settings', JSON.stringify(settings)], env };
    }
    if ([cwd, project.path].some(hasCodexHooks)) return null;
    // Codex runs a hook through the platform shell (PowerShell on Windows): a bare path runs everywhere, a quoted one
    // needs PowerShell's call operator there.
    const paths = [process.execPath, HOOK_SCRIPT].map(slash);
    const command = paths.some((p) => /\s/.test(p))
      ? `${process.platform === 'win32' ? '& ' : ''}${paths.map((p) => `"${p}"`).join(' ')}`
      : paths.join(' ');
    // A JSON string is also a valid TOML basic string.
    const toml = `[{matcher=${JSON.stringify('^Bash$')},hooks=[{type="command",command=${JSON.stringify(command)},timeout=${HOOK_TIMEOUT_S}}]}]`;
    return { args: ['--dangerously-bypass-hook-trust', '-c', `hooks.PreToolUse=${toml}`], env };
  }

  /** At startup: start the CBM session, so chats get the tools. */
  start(): void {
    if (this.settings().enabled) void this.connection().catch(() => {});
  }

  async stop(): Promise<void> {
    await this.disconnect();
  }
}
