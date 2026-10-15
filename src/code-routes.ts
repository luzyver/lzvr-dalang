import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, createWriteStream, type Stats } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Dispatcher } from './dispatcher.js';
import * as git from './git.js';
import { agentBusy } from './git-routes.js';
import { insideRoot } from './paths.js';
import type { Store } from './store.js';

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

/** The file has a NUL byte near its start: not text the editor should show. */
const looksBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

/**
 * The code editor's file manager: list, read, write, create, rename, delete and upload files, always inside the folder
 * a chat works in (its worktree, else the project folder). Changing files follows the agent's rules there: never in a
 * read-only project, and not while an agent is working in that folder. `.git` is never written to.
 */
export function codeRoutes(app: FastifyInstance, deps: { store: Store; dispatcher: Dispatcher; terminalAvailable: () => Promise<boolean> }): void {
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
      terminal: req.user?.role === 'admin' && (await deps.terminalAvailable()),
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

  // Every file, for "Go to file": what git tracks plus untracked files it does not ignore, else a walk of the folder.
  app.get<{ Params: { id: string } }>('/api/conversations/:id/fs/files', async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
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
