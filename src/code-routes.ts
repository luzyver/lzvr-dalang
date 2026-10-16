import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, createWriteStream, type Stats } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Dispatcher } from './dispatcher.js';
import * as git from './git.js';
import { agentBusy } from './git-routes.js';
import { insideRoot } from './paths.js';
import type { Store } from './store.js';
import type { AuthUser } from './util.js';

type Reply = FastifyReply;

/** Files the editor opens as text; bigger ones can only be downloaded. */
export const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const MAX_LIST = 5000;
const MAX_FILES = 20_000;
/** Skipped when listing every file of a folder that is not a git repository (one that is uses its .gitignore). */
const HEAVY_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', '.venv', 'venv', '__pycache__', '.cache']);

/** Why `name` cannot be a file or folder name here (on Linux and Windows alike), or null if it can. */
export function badName(name: string): string | null {
  if (!name || name === '.' || name === '..') return 'enter a name';
  if (name.length > 255) return 'that name is too long';
  if (/[\\/]/.test(name)) return 'a name cannot contain / or \\';
  if (/[\u0000-\u001f<>:"|?*]/.test(name)) return 'a name cannot contain control characters or < > : " | ? *';
  if (/[. ]$/.test(name)) return 'a name cannot end with a dot or a space';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) return `${name} is a reserved name on Windows`;
  return null;
}

const MAX_MATCHES = 2000;
const MAX_SEARCH_BYTES = 1024 * 1024;

export interface SearchQuery { query: string; regex?: boolean; matchCase?: boolean; word?: boolean; include?: string; exclude?: string }
export interface SearchMatch { line: number; col: number; len: number; preview: string; at: number }

/** The search as a global regular expression (throws on an invalid regex). */
export function searchRegExp(q: SearchQuery): RegExp {
  let src = q.regex ? q.query : q.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (q.word) src = `\\b(?:${src})\\b`;
  return new RegExp(src, `g${q.matchCase ? '' : 'i'}m`);
}

/** `src/**`, `*.ts, docs/` and the like: comma-separated globs; one without a slash matches any part of the path. */
export function globList(list: string | undefined): RegExp[] {
  return (list ?? '').split(',').map((g) => g.trim()).filter(Boolean).map((g) => {
    const body = g.replace(/\/+$/, '/**').split(/(\*\*\/?|\*|\?)/).map((part) => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }).join('');
    return new RegExp(g.includes('/') ? `^${body}$` : `(^|/)${body}(/|$)`, 'i');
  });
}

/** Every match of `re` in `text` (up to `limit`), with 1-based line and column and a short preview of its line. */
export function findMatches(text: string, re: RegExp, limit: number): SearchMatch[] {
  const out: SearchMatch[] = [];
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  re.lastIndex = 0;
  let line = 0;
  for (let m = re.exec(text); m && out.length < limit; m = re.exec(text)) {
    if (!m[0].length) { re.lastIndex++; continue; } // an empty match (a regex like `x*`) has nothing to show
    while (line + 1 < starts.length && starts[line + 1]! <= m.index) line++;
    const from = starts[line]!;
    const end = line + 1 < starts.length ? starts[line + 1]! - 1 : text.length;
    const lineText = text.slice(from, end).replace(/\r$/, '');
    const col = m.index - from;
    const cut = Math.max(0, col - 60);
    out.push({ line: line + 1, col: col + 1, len: Math.max(1, Math.min(m[0].length, lineText.length - col)), preview: lineText.slice(cut, col + 200), at: col - cut });
  }
  re.lastIndex = 0;
  return out;
}

/** The file has a NUL byte near its start: not text the editor should show. */
const looksBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

/**
 * The code editor's file manager: list, read, write, create, rename, delete and upload files, always inside the folder
 * a chat works in (its worktree, else the project folder). Changing files follows the agent's rules there: never in a
 * read-only project, and not while an agent is working in that folder. `.git` is never written to.
 */
export function codeRoutes(app: FastifyInstance, deps: {
  store: Store; dispatcher: Dispatcher;
  /** As whom this caller's terminals run ('server' or TERMINAL_USER's name), or null for none. */
  terminalAs: (user: AuthUser) => Promise<string | null>;
}): void {
  const { store, dispatcher } = deps;
  const notFound = (reply: Reply) => reply.code(404).send({ error: 'not found' });

  /** The chat, its project and the real path of its folder, or null after replying 404. */
  const load = (id: string, reply: Reply) => {
    const conv = store.getConversation(id);
    const project = conv && store.getProject(conv.project_id);
    let root: string | null = null;
    try { if (conv && project) root = realpathSync(conv.worktree ?? project.path); } catch { /* folder gone */ }
    if (!conv || !project || !root) { notFound(reply); return null; }
    return { conv, project, root, dir: conv.worktree ?? project.path };
  };
  type Loaded = NonNullable<ReturnType<typeof load>>;

  /** Path relative to the root with forward slashes, as the panel names files. */
  const rel = (root: string, real: string) => relative(root, real).split(sep).join('/');
  const inGit = (p: string) => p.split('/').includes('.git');
  /** An existing file or folder inside the root (symlinks resolved), or null. */
  const existing = (c: Loaded, p: string) => insideRoot(c.root, p || '.');
  /** A path to create: its parent must exist inside the root and its name be valid. */
  const fresh = (c: Loaded, p: string, reply: Reply) => {
    const name = basename(p);
    const err = badName(name);
    if (err) { reply.code(400).send({ error: err }); return null; }
    const parent = insideRoot(c.root, dirname(p) || '.');
    if (!parent) { reply.code(400).send({ error: 'that folder does not exist' }); return null; }
    const target = join(parent, name);
    if (inGit(rel(c.root, target))) { reply.code(403).send({ error: '.git is managed by git, not the editor' }); return null; }
    return target;
  };

  const busy = (c: Loaded) => agentBusy(store, dispatcher, c.project, [c.dir]);
  const mayWrite = (c: Loaded, reply: Reply) => {
    if (c.project.sandbox === 'read-only') { reply.code(403).send({ error: 'read-only project: files cannot be changed here' }); return false; }
    if (busy(c)) { reply.code(409).send({ error: 'an agent is working in this folder: wait for its turn to finish or stop it' }); return false; }
    return true;
  };
  /** An existing path that may be changed: inside the root, not the root itself, not in .git. */
  const target = (c: Loaded, p: string, reply: Reply) => {
    const real = existing(c, p);
    if (!real) { notFound(reply); return null; }
    const r = rel(c.root, real);
    if (!r) { reply.code(400).send({ error: 'the root folder cannot be changed' }); return null; }
    if (inGit(r)) { reply.code(403).send({ error: '.git is managed by git, not the editor' }); return null; }
    return real;
  };
  const statOf = (p: string): Stats | null => { try { return statSync(p); } catch { return null; } };

  const pathBody = { type: 'string', maxLength: 4096 };

  // What the editor shows around the files: whose they are, and whether it may change them or open a terminal.
  app.get<{ Params: { id: string } }>('/api/conversations/:id/code', async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    return {
      project: { id: c.project.id, name: c.project.name, backend: c.project.backend },
      conv: { id: c.conv.id, title: c.conv.title, branch: c.conv.branch, worktree: !!c.conv.worktree },
      root: basename(c.root),
      readOnly: c.project.sandbox === 'read-only',
      busy: busy(c),
      terminal: !!req.user && (await deps.terminalAs(req.user)) !== null && !(c.project.sandbox === 'read-only' && req.user.role !== 'admin'),
      terminalAs: req.user ? await deps.terminalAs(req.user) : null,
    };
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/conversations/:id/fs/list', {
    schema: { querystring: { type: 'object', properties: { path: pathBody } } },
  }, (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    const dir = existing(c, req.query.path ?? '');
    if (!dir || !statOf(dir)?.isDirectory()) return notFound(reply);
    const entries = [];
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name === '.git') continue;
      const s = statOf(join(dir, d.name)); // follows symlinks; a broken one is left out
      if (!s) continue;
      entries.push({ name: d.name, dir: s.isDirectory(), size: s.size, mtime: s.mtimeMs });
      if (entries.length >= MAX_LIST) break;
    }
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    return { path: rel(c.root, dir), entries, truncated: entries.length >= MAX_LIST };
  });

  /** Every file: what git tracks plus untracked files it does not ignore, else a walk of the folder. */
  const listFiles = async (c: Loaded): Promise<{ files: string[]; truncated: boolean }> => {
    if (await git.isRepo(c.root)) {
      const out = await git.git(c.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).catch(() => null);
      if (out !== null) {
        const files = [...new Set(out.split('\0').filter(Boolean))];
        return { files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
      }
    }
    const files: string[] = [];
    const walk = (dir: string, prefix: string) => {
      let list;
      try { list = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of list) {
        if (files.length >= MAX_FILES) return;
        if (d.isDirectory()) { if (!HEAVY_DIRS.has(d.name)) walk(join(dir, d.name), `${prefix}${d.name}/`); } else if (d.isFile()) files.push(prefix + d.name);
      }
    };
    walk(c.root, '');
    return { files, truncated: files.length >= MAX_FILES };
  };

  // For "Go to file".
  app.get<{ Params: { id: string } }>('/api/conversations/:id/fs/files', async (req, reply) => {
    const c = load(req.params.id, reply);
    if (c) return listFiles(c);
  });

  const queryProps = {
    query: { type: 'string', minLength: 1, maxLength: 1000 }, regex: { type: 'boolean' }, matchCase: { type: 'boolean' },
    word: { type: 'boolean' }, include: { type: 'string', maxLength: 1000 }, exclude: { type: 'string', maxLength: 1000 },
  };
  /** The files a search looks in (filtered by the include/exclude globs) and its regex, or null after a 400. */
  const searchable = async (c: Loaded, q: SearchQuery, reply: Reply) => {
    let re: RegExp;
    try { re = searchRegExp(q); } catch (e) { reply.code(400).send({ error: `invalid regular expression: ${(e as Error).message}` }); return null; }
    const include = globList(q.include);
    const exclude = globList(q.exclude);
    const { files } = await listFiles(c);
    return { re, files: files.filter((f) => (!include.length || include.some((g) => g.test(f))) && !exclude.some((g) => g.test(f))) };
  };
  /** A text file up to 1 MB inside the folder, or null. */
  const readText = async (c: Loaded, path: string) => {
    const real = existing(c, path);
    if (!real) return null;
    try {
      const s = await stat(real);
      if (!s.isFile() || s.size > MAX_SEARCH_BYTES) return null;
      const buf = await readFile(real);
      return looksBinary(buf) ? null : { real, text: buf.toString('utf8') };
    } catch { return null; }
  };

  // Find in files: every match with its line, and a preview of that line around it.
  app.post<{ Params: { id: string }; Body: SearchQuery }>('/api/conversations/:id/fs/search', {
    schema: { body: { type: 'object', required: ['query'], additionalProperties: false, properties: queryProps } },
  }, async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    const s = await searchable(c, req.body, reply);
    if (!s) return;
    const results: { path: string; matches: SearchMatch[] }[] = [];
    let count = 0;
    let truncated = false;
    for (let i = 0; i < s.files.length && !truncated; i += 32) {
      const batch = await Promise.all(s.files.slice(i, i + 32).map(async (path) => ({ path, file: await readText(c, path) })));
      for (const { path, file } of batch) {
        if (!file) continue;
        const matches = findMatches(file.text, s.re, MAX_MATCHES - count);
        if (!matches.length) continue;
        results.push({ path, matches });
        count += matches.length;
        if (count >= MAX_MATCHES) { truncated = true; break; }
      }
    }
    return { results, count, truncated };
  });

  // Replace in files: the same search, in the files named (the ones the panel showed), each written once. With a
  // regex the replacement may use `$1`, `$&` and so on, as in JavaScript; otherwise it is literal text.
  app.post<{ Params: { id: string }; Body: SearchQuery & { replace: string; paths: string[] } }>('/api/conversations/:id/fs/replace', {
    schema: { body: { type: 'object', required: ['query', 'replace', 'paths'], additionalProperties: false, properties: {
      ...queryProps, replace: { type: 'string', maxLength: 10_000 }, paths: { type: 'array', maxItems: 5000, items: { ...pathBody, minLength: 1 } },
    } } },
  }, async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c || !mayWrite(c, reply)) return;
    const s = await searchable(c, req.body, reply);
    if (!s) return;
    const allowed = new Set(s.files);
    const by = req.body.regex ? req.body.replace : () => req.body.replace;
    let files = 0;
    let replacements = 0;
    for (const path of new Set(req.body.paths)) {
      if (!allowed.has(path) || inGit(path)) continue;
      const file = await readText(c, path);
      if (!file) continue;
      const n = findMatches(file.text, s.re, Infinity).length;
      if (!n) continue;
      const next = file.text.replace(s.re, by as string);
      if (next === file.text) continue;
      await writeFile(file.real, next);
      files++;
      replacements += n;
    }
    return { files, replacements };
  });

  app.get<{ Params: { id: string }; Querystring: { path: string } }>('/api/conversations/:id/fs/file', {
    schema: { querystring: { type: 'object', required: ['path'], properties: { path: { ...pathBody, minLength: 1 } } } },
  }, (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    const real = existing(c, req.query.path);
    const s = real ? statOf(real) : null;
    if (!real || !s?.isFile()) return notFound(reply);
    const base = { path: rel(c.root, real), size: s.size, mtime: s.mtimeMs };
    if (s.size > MAX_EDIT_BYTES) return { ...base, tooLarge: true };
    const buf = readFileSync(real);
    if (looksBinary(buf)) return { ...base, binary: true };
    return { ...base, content: buf.toString('utf8') };
  });

  // Save. `mtime` is when the editor loaded the file: if it changed on disk since (the agent, a terminal), the save is
  // refused so neither side's work is lost silently; leave it out to overwrite anyway.
  app.put<{ Params: { id: string }; Body: { path: string; content: string; mtime?: number } }>('/api/conversations/:id/fs/file', {
    bodyLimit: MAX_EDIT_BYTES * 2,
    schema: { body: { type: 'object', required: ['path', 'content'], additionalProperties: false,
      properties: { path: { ...pathBody, minLength: 1 }, content: { type: 'string' }, mtime: { type: 'number' } } } },
  }, (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c || !mayWrite(c, reply)) return;
    const real = target(c, req.body.path, reply);
    if (!real) return;
    const s = statOf(real);
    if (!s?.isFile()) return reply.code(400).send({ error: 'not a file' });
    if (req.body.mtime !== undefined && s.mtimeMs !== req.body.mtime) {
      return reply.code(409).send({ error: 'the file changed on disk since it was opened', changed: true, mtime: s.mtimeMs });
    }
    writeFileSync(real, req.body.content);
    const after = statSync(real);
    return { path: rel(c.root, real), size: after.size, mtime: after.mtimeMs };
  });

  app.post<{ Params: { id: string }; Body: { path: string; dir?: boolean } }>('/api/conversations/:id/fs/new', {
    schema: { body: { type: 'object', required: ['path'], additionalProperties: false,
      properties: { path: { ...pathBody, minLength: 1 }, dir: { type: 'boolean' } } } },
  }, (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c || !mayWrite(c, reply)) return;
    const real = fresh(c, req.body.path, reply);
    if (!real) return;
    if (statOf(real)) return reply.code(409).send({ error: `${basename(real)} already exists` });
    if (req.body.dir) mkdirSync(real);
    else writeFileSync(real, '', { flag: 'wx' });
    return reply.code(201).send({ path: rel(c.root, real) });
  });

  app.post<{ Params: { id: string }; Body: { from: string; to: string } }>('/api/conversations/:id/fs/rename', {
    schema: { body: { type: 'object', required: ['from', 'to'], additionalProperties: false,
      properties: { from: { ...pathBody, minLength: 1 }, to: { ...pathBody, minLength: 1 } } } },
  }, (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c || !mayWrite(c, reply)) return;
    const from = target(c, req.body.from, reply);
    if (!from) return;
    const to = fresh(c, req.body.to, reply);
    if (!to) return;
    const into = rel(from, to);
    if (into && !into.startsWith('..')) return reply.code(400).send({ error: 'a folder cannot move into itself' });
    // Only a change of case on a case-insensitive disk finds the target "existing": that is the same file.
    if (statOf(to) && realpathSync(to) !== from) return reply.code(409).send({ error: `${basename(to)} already exists` });
    renameSync(from, to);
    return { path: rel(c.root, to) };
  });

  app.post<{ Params: { id: string }; Body: { path: string } }>('/api/conversations/:id/fs/delete', {
    schema: { body: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { ...pathBody, minLength: 1 } } } },
  }, (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c || !mayWrite(c, reply)) return;
    const real = target(c, req.body.path, reply);
    if (!real) return;
    rmSync(real, { recursive: true, force: true });
    return reply.code(204).send();
  });

  // Upload one file into a folder. An existing file of that name is only replaced with `replace=1`.
  app.post<{ Params: { id: string }; Querystring: { dir?: string; replace?: string } }>('/api/conversations/:id/fs/upload', {
    schema: { querystring: { type: 'object', properties: { dir: pathBody, replace: { type: 'string' } } } },
  }, async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c || !mayWrite(c, reply)) return;
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'multipart field "file" required' });
    const dir = req.query.dir ?? '';
    const name = part.filename.replace(/\\/g, '/').split('/').pop() ?? ''; // a name only, never a path of its own
    const real = fresh(c, dir ? `${dir}/${name}` : name, reply);
    if (!real) { part.file.resume(); return; }
    const s = statOf(real);
    if (s && (s.isDirectory() || req.query.replace !== '1')) {
      part.file.resume();
      return reply.code(409).send({ error: `${basename(real)} already exists`, exists: true });
    }
    const tmp = `${real}.dalang-upload`;
    await pipeline(part.file, createWriteStream(tmp));
    if (part.file.truncated) { // multipart silently cuts the stream at the limit
      rmSync(tmp, { force: true });
      return reply.code(413).send({ error: 'the file is too large' });
    }
    renameSync(tmp, real);
    return reply.code(201).send({ path: rel(c.root, real) });
  });

  // The open files' modification times, and whether an agent works in the folder: the editor polls this to notice
  // changes made outside it.
  app.post<{ Params: { id: string }; Body: { paths: string[] } }>('/api/conversations/:id/fs/stat', {
    schema: { body: { type: 'object', required: ['paths'], additionalProperties: false,
      properties: { paths: { type: 'array', maxItems: 100, items: { ...pathBody, minLength: 1 } } } } },
  }, (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    const files: Record<string, number | null> = {};
    for (const p of req.body.paths) {
      const real = existing(c, p);
      const s = real ? statOf(real) : null;
      files[p] = s?.isFile() ? s.mtimeMs : null;
    }
    return { busy: busy(c), files };
  });
}
