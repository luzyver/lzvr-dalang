import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from './config.js';
import type { Dispatcher } from './dispatcher.js';
import { createPullRequest, mergePr, parsePrUrl, parseRemote, prStatus, remoteRepo, sshHostName, type MergeMethod } from './forge.js';
import * as git from './git.js';
import type { GitUsers } from './git-users.js';
import { gitContext } from './git.js';
import type { AuthUser, Backend } from './util.js';
import type { Conversation, Project, Store } from './store.js';

/**
 * A new chat with its own worktree: a branch `dalang/<id>` from the project's HEAD, checked out under
 * `<STATE_DIR>/worktrees/<chat id>`, so parallel chats in one project never write over each other's files.
 */
export async function createWorktreeChat(store: Store, cfg: Config, project: Project, o: { backend?: Backend; parent?: string } = {}): Promise<Conversation> {
  if (!(await git.isRepo(project.path))) throw new git.GitError('the project folder is not a git repository');
  const conv = store.createConversation(project.id, o.backend, o.parent);
  const dir = join(cfg.stateDir, 'worktrees', conv.id);
  const branch = `dalang/${conv.id.slice(0, 8)}`;
  try {
    const base = await git.addWorktree(project.path, dir, branch);
    store.setWorktree(conv.id, { dir, branch, base });
  } catch (e) {
    store.deleteConversation(conv.id);
    throw e;
  }
  return store.getConversation(conv.id)!;
}

/**
 * Remove the worktrees and turn checkpoints of chats that are being deleted. Call after cancelling their turns: it waits
 * for each agent to exit first, since its files are still open until then. Never throws (a leftover folder is only logged).
 */
export async function dropWorktrees(dispatcher: Dispatcher, project: Project, convs: Conversation[]): Promise<void> {
  for (const c of convs) {
    for (let i = 0; i < 200 && dispatcher.isRunning(c.id); i++) await new Promise((r) => setTimeout(r, 50));
    await git.dropCheckpoints(project.path, c.id);
    if (!c.worktree) continue;
    await git.removeWorktree(project.path, c.worktree, c.branch).catch((e) => console.error(`could not remove worktree ${c.worktree}`, e));
  }
}

/** Any chat whose agent works in one of these folders and is running right now. */
export const agentBusy = (store: Store, dispatcher: Dispatcher, project: Project, dirs: string[]) =>
  store.listConversations(project.id).some((c) => dirs.includes(c.worktree ?? project.path) && dispatcher.isRunning(c.id));

type Reply = FastifyReply;

const MAX_PROMPT_DIFF = 60_000; // characters of diff given to the agent; the rest is only named

/** The instructions for "Generate message" unless an admin saved others (setting `commit_prompt`). Shared by both agent CLIs. */
export const DEFAULT_COMMIT_PROMPT = `You are an expert at writing Git commits. Write a single-sentence commit subject only.

Rules:
- Return only the commit subject
- Do not include a body
- Do not use bullet points
- Keep it concise and clear
- Prefer 100 characters or fewer
- Use Conventional Commit format: <type>: <subject>
- Use one lowercase type only, such as:
  feat: for new features
  fix: for bug fixes
  chore: for maintenance tasks
  docs: for documentation changes
  style: for formatting-only changes
  refactor: for code changes without feature or fix
  test: for adding or updating tests
  perf: for performance improvements
  build: for build or dependency changes
  ci: for CI/CD changes
- Capitalize the subject after the prefix
- Do not end with punctuation
- Use the imperative mood
- Summarize the most important change only`;

/**
 * The instructions, then what git says about the change (the agent gets no tools): which files are in it, their diffs,
 * the recent commits, and what the chat was asked to do.
 */
export async function commitMessagePrompt(cwd: string, files: git.GitFile[], requests: string[], instructions = DEFAULT_COMMIT_PROMPT): Promise<string> {
  const log = await git.git(cwd, ['log', '-15', '--format=%s']).catch(() => '');
  let budget = MAX_PROMPT_DIFF;
  const diffs: string[] = [];
  for (const f of files) {
    const d = budget > 0 ? await git.fileDiff(cwd, f).catch(() => '') : '';
    const shown = d.slice(0, Math.max(0, budget));
    budget -= shown.length;
    const name = `${f.status.trim() || 'M'} ${f.from ? `${f.from} -> ` : ''}${f.path}`;
    diffs.push(`--- ${name}\n${shown || '(diff not shown)'}${shown.length < d.length ? '\n… truncated' : ''}`);
  }
  return [
    instructions.trim(),
    '\n=====\nContext gathered from git; everything you need is here, so do not run any tools.',
    'Only the files listed below are part of this change; ignore other uncommitted files.',
    'Reply with the commit subject only: no quotes, no code fence, no commentary.',
    log.trim() && `\nRecent commits:\n${log.trim()}`,
    requests.length && `\nThe change was made for these requests in the chat (oldest first):\n${requests.map((r) => `- ${r.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')}`,
    `\nChanged files and their diffs:\n${diffs.join('\n\n')}`,
  ].filter(Boolean).join('\n');
}

/** The instructions for "Generate MR description" unless an admin saved others (setting `mr_prompt`). */
export const DEFAULT_MR_PROMPT = `You are an expert at writing Merge Request descriptions.

Before writing, gather context using git:
- Check what files changed and the diff
- Check recent commit messages for context

Rules:
- Write in English
- Use this exact format:

## Title
\`<type>: <short description>\`

Use conventional commit types: feat, fix, chore, refactor, docs, style, test, perf, build, ci

## Summary
- <bullet points of what changed and why>

## Changes
- **\`<file_path>\`**: <what changed in this file>

## Additional Info (if applicable)
<Include any of the following that are relevant:>
- Request/response examples for API changes
- Before/after behavior for bug fixes
- Migration steps for breaking changes
- Environment variables or config changes

---
- Keep each bullet point concise
- Focus on the WHY not just the WHAT
- Do not include implementation details that are obvious from the code
- Omit sections that are not relevant to the change
- Title must be 70 characters or fewer`;

/**
 * What a chat's Merge Request would go from and into. `base.name` is null when there is no branch to open one into.
 * `usual` is the branch it would go into without a pick (see mrTarget), `picked` whether the chat goes into another one,
 * `missing` whether that branch is not in this repository (nor its remote-tracking copy), so nothing compares against it.
 */
export interface MrTarget { branch: string; base: { name: string | null; ref: string }; usual: string | null; picked: boolean; missing: boolean }

/** The Merge Request this chat opened for `branch`; rows from before `pr_branch` existed are worktree chats only. */
export const prFor = (conv: Conversation, branch: string) =>
  (conv.pr_branch ? conv.pr_branch === branch : !!conv.worktree) ? conv.pr_url : null;

/**
 * A worktree chat proposes its own branch into the branch it started from. A plain chat proposes whatever branch the
 * project folder has checked out into the remote's default branch, unless that is the default branch itself. A branch
 * picked for the chat (`mr_base`) goes first while it exists and is not the branch proposed; once a Merge Request was
 * opened into it, it stays the target even when its ref is gone here (the forge still has it).
 */
export async function mrTarget(conv: Conversation, project: Project): Promise<MrTarget | null> {
  const own = !!(conv.worktree && conv.branch);
  const branch = own ? conv.branch! : await git.currentBranch(project.path);
  if (!branch) return null;
  const usual = own ? { name: conv.base_branch, ref: conv.base_branch ?? 'HEAD' } : await git.defaultBranch(project.path);
  const chosen = conv.mr_base && conv.mr_base !== branch ? conv.mr_base : null;
  const found = chosen ? await git.branchRef(project.path, chosen) : null;
  const kept = chosen && !found && prFor(conv, branch) ? { name: chosen, ref: chosen } : null;
  const base = found ?? kept ?? usual;
  if (!base || base.name === branch) return null;
  return { branch, base, usual: usual?.name ?? null, picked: base.name !== usual?.name, missing: !!kept };
}

/**
 * The instructions, then what the merge would bring (the agent gets no tools): the branch's commits, its changed files
 * and the diff against the merge base with the target branch, and what the chat was asked to do.
 */
export async function mrDescriptionPrompt(repo: string, branch: string, target: MrTarget['base'], requests: string[], instructions = DEFAULT_MR_PROMPT): Promise<string> {
  const range = `${target.ref}...${branch}`;
  const [commits, stat, diff, recent] = await Promise.all([
    git.git(repo, ['log', '--reverse', '--format=- %s%n%b', `${target.ref}..${branch}`]).catch(() => ''),
    git.git(repo, ['diff', '--no-color', '--stat=200', range]).catch(() => ''),
    git.git(repo, ['diff', '--no-color', range]).catch(() => ''),
    git.git(repo, ['log', '-10', '--format=%s', target.ref]).catch(() => ''),
  ]);
  const shown = diff.slice(0, MAX_PROMPT_DIFF);
  return [
    instructions.trim(),
    '\n=====\nContext gathered from git; everything you need is here, so do not run any tools.',
    `It describes merging branch ${branch} into ${target.name}.`,
    'Reply with the description only: no code fence around it, no commentary.',
    recent.trim() && `\nRecent commits on the target branch:\n${recent.trim()}`,
    `\nCommits on ${branch} (oldest first):\n${commits.replace(/\n{2,}/g, '\n').trim() || '(none)'}`,
    requests.length && `\nThe change was made for these requests in the chat (oldest first):\n${requests.map((r) => `- ${r.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')}`,
    `\nChanged files:\n${stat.trim()}`,
    `\nDiff:\n${shown}${shown.length < diff.length ? '\n… diff truncated' : ''}`,
  ].filter(Boolean).join('\n');
}

/**
 * A commit message from a Merge Request description: the `## Title` line (without its backticks) is the subject and
 * the other sections are the body. Text without a Title section is used as it is.
 */
export function toCommitMessage(description: string): string {
  const lines = description.split('\n');
  const at = lines.findIndex((l) => /^#{1,3}\s*title\s*$/i.test(l.trim()));
  if (at === -1) return description;
  let i = at + 1;
  while (i < lines.length && !lines[i]!.trim()) i++;
  const subject = (lines[i] ?? '').trim().replace(/^`+|`+$/g, '').trim();
  if (!subject || /^#/.test(subject)) return description;
  const body = [...lines.slice(0, at), ...lines.slice(i + 1)].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return body ? `${subject}\n\n${body}` : subject;
}

/** Agents like to wrap the answer anyway: drop code fences and surrounding quotes. */
export function cleanMessage(text: string): string {
  let m = text.trim().replace(/^```[\w-]*\n([\s\S]*?)\n```$/, '$1').trim();
  const quoted = /^(["'`])((?:(?!\1)[\s\S])*)\1$/.exec(m); // one quoted whole, not "a" and "b"
  if (quoted) m = quoted[2]!.trim();
  return m;
}

export function gitRoutes(app: FastifyInstance, deps: { store: Store; dispatcher: Dispatcher; cfg: Config; users: GitUsers }): void {
  const { store, dispatcher, cfg, users } = deps;

  // Every git, gh, glab and ssh these routes run works as the caller: the owner with the server's setup, anyone else
  // with their own (see GitUsers). A callback hook, so the context carries into the handler (as @fastify/request-context does).
  // `run` and `exit` scope it to this request: `enterWith` could leave a user's context on the caller's async context,
  // where the next request (the owner's, say) would pick it up on Node versions before AsyncContextFrame.
  app.addHook('preHandler', (req, _reply, done) => {
    const id = /^\/api\/conversations\/([^/?]+)\/git(?:[/?]|$)/.exec(req.url)?.[1];
    if (!id || !req.user) return done();
    if (req.user.id === null) return gitContext.exit(done);
    const conv = store.getConversation(decodeURIComponent(id));
    gitContext.run(users.context(req.user.id, conv?.project_id), done);
  });
  const notFound = (reply: Reply) => reply.code(404).send({ error: 'not found' });

  /** The chat, its project and the folder git runs in, or null after replying 404. */
  const load = (id: string, reply: Reply) => {
    const conv = store.getConversation(id);
    const project = conv && store.getProject(conv.project_id);
    if (!conv || !project) { notFound(reply); return null; }
    return { conv, project, cwd: conv.worktree ?? project.path };
  };

  const busy = (project: Project, dirs: string[]) => agentBusy(store, dispatcher, project, dirs);

  /**
   * Changing files is refused while an agent works in the same folder (both would edit it at once), and in a
   * read-only project for anyone but an admin: there the agent may not write either.
   */
  const mayWrite = (req: { user?: { role: string } }, reply: Reply, project: Project, dirs: string[]) => {
    if (project.sandbox === 'read-only' && req.user?.role !== 'admin') { reply.code(403).send({ error: 'read-only project: admin only' }); return false; }
    if (busy(project, dirs)) { reply.code(409).send({ error: 'an agent is working in this folder: wait for its turn to finish or stop it' }); return false; }
    return true;
  };

  const noTarget = 'no Merge Request to open: check out a branch other than the default branch (or use a worktree chat)';
  const aheadOf = async (repo: string, t: MrTarget) =>
    Number((await git.git(repo, ['rev-list', '--count', `${t.base.ref}..${t.branch}`]).catch(() => '0')).trim()) || 0;

  const gitFailed = (reply: Reply, e: unknown) => {
    if (e instanceof git.GitError) return reply.code(400).send({ error: e.message });
    throw e;
  };

  /** Only paths git itself reported as changed may be named, so nothing outside the change list can be touched. */
  const pick = async (cwd: string, paths: string[], reply: Reply) => {
    const s = await git.status(cwd);
    if (!s.repo) { reply.code(400).send({ error: 'not a git repository' }); return null; }
    const files = paths.map((p) => s.files.find((f) => f.path === p));
    const missing = paths.find((_, i) => !files[i]);
    if (missing !== undefined) { reply.code(400).send({ error: `not a changed file: ${missing}` }); return null; }
    return files as git.GitFile[];
  };

  app.get<{ Params: { id: string } }>('/api/conversations/:id/git', async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    const s = await git.status(c.cwd);
    if (!s.repo) return s;
    const t = await mrTarget(c.conv, c.project);
    const base = await syncBase(c);
    // Commits on the branch that its target (or, if a worktree had none, the project folder's HEAD) does not have yet,
    // and the ones the target got since the branch left it (as of the last fetch).
    const mr = t && {
      branch: t.branch, base: t.base.name, ahead: await aheadOf(c.project.path, t), pr: prFor(c.conv, t.branch),
      behind: base ? Number((await git.git(c.cwd, ['rev-list', '--count', `HEAD..${base.ref}`]).catch(() => '0')).trim()) || 0 : 0,
      baseRef: base?.ref ?? null, usual: t.usual, picked: t.picked, baseMissing: t.missing,
    };
    // No target (a plain chat on the default branch): the branch it could still propose into a picked one.
    const pickFrom = !t && !c.conv.worktree ? s.branch : null;
    return { ...s, worktree: c.conv.worktree ? mr : null, mr, mrPick: pickFrom && { branch: pickFrom, usual: (await git.defaultBranch(c.project.path))?.name ?? null } };
  });

  /**
   * What "sync with the base branch" brings in: the branch a Merge Request from here would go into, as the remote has it
   * when it has it (a local copy may be stale), else the local branch. Null when there is no such branch.
   */
  const syncBase = async (c: { conv: Conversation; project: Project; cwd: string }) => {
    const t = await mrTarget(c.conv, c.project);
    if (!t?.base.name) return null;
    return { name: t.base.name, ref: (await git.remoteBranch(c.cwd, t.base.name)) ?? t.base.ref };
  };

  /**
   * What the credentials card shows, for whoever asks: the owner sees the server's setup; anyone else their own, with
   * the author Dalang sets for them (their project author, else their global one) rather than the repository's.
   */
  const credentialsFor = async (req: { user?: AuthUser }, c: { cwd: string; project: Project }, check: boolean) => {
    const userId = req.user?.id ?? null;
    const ctx = users.forUser(userId, c.project.id);
    const out = await users.auth(userId).credentials(c.cwd, { forge: cfg.forge, check, env: ctx?.env });
    if (userId === null) return out;
    const id = users.identity(userId, c.project.id);
    const repo = users.repoIdentity(userId, c.project.id);
    return {
      ...out, author: id, localAuthor: repo ?? { name: '', email: '' },
      ...(id ? { authorError: undefined } : { authorError: 'set your name and email in Settings → Git & forges' }),
    };
  };

  // Who a commit here is by and which credentials its push and Merge Request use. `check=1` also asks the forge
  // which account that is (ssh -T, gh/glab auth status): slower, so the panel asks for it on demand.
  app.get<{ Params: { id: string }; Querystring: { check?: string } }>('/api/conversations/:id/git/credentials', async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    if (!(await git.isRepo(c.cwd))) return reply.code(400).send({ error: 'not a git repository' });
    return credentialsFor(req, c, req.query.check === '1');
  });

  // The author for this repository only; both empty: the global one again. For the owner that is the repository's own
  // config (`git config --local`, shared by its worktrees); for anyone else Dalang keeps it per user and project.
  app.put<{ Params: { id: string }; Body: { name: string; email: string } }>('/api/conversations/:id/git/identity', {
    schema: { body: { type: 'object', required: ['name', 'email'], additionalProperties: false, properties: {
      name: { type: 'string', maxLength: 200 }, email: { type: 'string', maxLength: 200 },
    } } },
  }, async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    if (c.project.sandbox === 'read-only' && req.user?.role !== 'admin') return reply.code(403).send({ error: 'read-only project: admin only' });
    if (!(await git.isRepo(c.cwd))) return reply.code(400).send({ error: 'not a git repository' });
    const name = req.body.name.trim();
    const email = req.body.email.trim();
    if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) return reply.code(400).send({ error: 'that does not look like an email address' });
    if (!name !== !email) return reply.code(400).send({ error: 'give both a name and an email, or neither to use the global ones' });
    const userId = req.user?.id ?? null;
    if (userId === null) {
      try { await users.server.setIdentity(name, email, c.cwd); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    } else users.setRepoIdentity(userId, c.project.id, name ? { name, email } : null);
    return credentialsFor(req, c, false);
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/conversations/:id/git/diff', {
    schema: { querystring: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } } } },
  }, async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    const files = await pick(c.cwd, [req.query.path!], reply);
    if (!files) return;
    return { diff: await git.fileDiff(c.cwd, files[0]!) };
  });

  const pathsSchema = { type: 'array', maxItems: 1000, items: { type: 'string', minLength: 1 } };

  // `paths` left out: every change; `hunks`: files of which only those hunks go in (indexes into the diff /git/diff
  // shows). `amend` replaces the last commit; one already pushed is force-pushed (with a lease), never on the default branch.
  // `hunkDiffs`: for each file in `hunks`, the fingerprint (git.diffFingerprint) of the diff its hunks were picked in;
  // a file that changed since is refused (409), as its hunk indexes may now point at other hunks.
  app.post<{ Params: { id: string }; Body: { message: string; paths?: string[]; hunks?: Record<string, number[]>; hunkDiffs?: Record<string, string>; amend?: boolean; push?: boolean } }>('/api/conversations/:id/git/commit', {
    schema: { body: { type: 'object', required: ['message'], additionalProperties: false, properties: {
      message: { type: 'string', minLength: 1, maxLength: 10_000, pattern: '\\S' }, paths: pathsSchema, amend: { type: 'boolean' }, push: { type: 'boolean' },
      hunks: { type: 'object', maxProperties: 1000, additionalProperties: { type: 'array', minItems: 1, maxItems: 10_000, items: { type: 'integer', minimum: 0 } } },
      hunkDiffs: { type: 'object', maxProperties: 1000, additionalProperties: { type: 'string', pattern: '^[0-9a-f]{8}$' } },
    } } },
  }, async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c || !mayWrite(req, reply, c.project, [c.cwd])) return;
    const { paths, hunks, amend } = req.body;
    if (paths?.length && !(await pick(c.cwd, paths, reply))) return;
    if (!paths && !amend && hunks) return reply.code(400).send({ error: 'name the files to commit when picking hunks' });
    if (paths && !paths.length && !amend) return reply.code(400).send({ error: 'nothing to commit: pick at least one file' });
    if (hunks) {
      const files = await pick(c.cwd, Object.keys(hunks), reply);
      if (!files) return;
      const whole = files.find((f) => f.status === '??' || f.status[0] === 'A' || f.from || git.isConflict(f));
      if (whole) return reply.code(400).send({ error: `${whole.path} is committed whole: hunks are only picked in changed files git already tracks` });
      for (const f of files) {
        const seen = req.body.hunkDiffs?.[f.path];
        if (!seen) return reply.code(400).send({ error: `hunkDiffs must name the diff the hunks of ${f.path} were picked in` });
        if (git.diffFingerprint(await git.fileDiff(c.cwd, f)) !== seen) {
          return reply.code(409).send({ error: `${f.path} changed since its hunks were picked: open its diff and pick them again`, stale: f.path });
        }
      }
    }
    // A commit goes straight to the remote too unless `push` is false (a worktree chat's branch gets one there, ready
    // for a Merge Request).
    try {
      const r = await git.commit(c.cwd, req.body.message, paths ?? null, { amend, hunks });
      return { commit: r.commit, push: req.body.push === false ? null : await git.push(c.cwd, { force: r.rewrote }) };
    } catch (e) { return gitFailed(reply, e); }
  });

  // Push the checked-out branch (it gets an upstream on its first push). `force` replaces the remote branch after a
  // rebase, with a lease (see git.push), and never the default branch. The body is optional.
  app.post<{ Params: { id: string }; Body: { force?: unknown } | undefined }>('/api/conversations/:id/git/push', async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c || !mayWrite(req, reply, c.project, [c.cwd])) return;
    if (!(await git.isRepo(c.cwd))) return reply.code(400).send({ error: 'not a git repository' });
    const force = req.body?.force === true;
    if (force && (await git.currentBranch(c.cwd)) === (await git.defaultBranch(c.cwd))?.name) {
      return reply.code(400).send({ error: 'the default branch is never force-pushed from here' });
    }
    const push = await git.push(c.cwd, { force });
    if (!push.pushed) return reply.code(400).send({ error: push.error ? `push failed: ${push.error}` : 'nothing to push to: no remote, or a detached HEAD' });
    return { push };
  });

  // Take back the last commit; its changes become uncommitted again. A pushed one needs `force` (409 without), and the
  // remote branch then moves back too.
  // The body is optional, so it is checked here rather than by a schema.
  app.post<{ Params: { id: string }; Body: { force?: unknown } | undefined }>('/api/conversations/:id/git/undo-commit', async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c || !mayWrite(req, reply, c.project, [c.cwd])) return;
    if (!(await git.isRepo(c.cwd))) return reply.code(400).send({ error: 'not a git repository' });
    try {
      return await git.undoCommit(c.cwd, req.body?.force === true);
    } catch (e) {
      if (e instanceof git.PushedError) return reply.code(409).send({ error: e.message, pushed: true });
      return gitFailed(reply, e);
    }
  });

  // Draft a commit message with the chat's agent CLI and the default model and effort from Settings. Changes nothing, so it is not limited like the rest.
  app.post<{ Params: { id: string }; Body: { paths?: string[] } | undefined }>('/api/conversations/:id/git/message', {
    schema: { body: { type: 'object', additionalProperties: false, properties: { paths: pathsSchema } } },
  }, async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    const s = await git.status(c.cwd);
    if (!s.repo) return reply.code(400).send({ error: 'not a git repository' });
    const paths = req.body?.paths ?? [];
    const files = paths.length ? await pick(c.cwd, paths, reply) : s.files;
    if (!files) return;
    if (!files.length) return reply.code(400).send({ error: 'nothing to commit' });
    const requests = store.listTurns(c.conv.id).slice(-5).map((t) => t.prompt);
    const prompt = await commitMessagePrompt(c.cwd, files, requests, store.getKv('commit_prompt') || DEFAULT_COMMIT_PROMPT);
    try {
      const answer = await dispatcher.ask(c.conv.backend, prompt, { cwd: c.cwd }); // Settings' default model and effort, not the chat's
      const message = cleanMessage(answer);
      return message ? { message } : reply.code(502).send({ error: 'the agent gave an empty answer' });
    } catch (e) {
      return reply.code(502).send({ error: `could not draft a message: ${(e as Error).message}` });
    }
  });

  // Describe what merging the chat's branch would bring, as a Merge Request description. Changes nothing.
  app.post<{ Params: { id: string } }>('/api/conversations/:id/git/mr-description', async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    const t = await mrTarget(c.conv, c.project);
    if (!t) return reply.code(400).send({ error: noTarget });
    if (!(await aheadOf(c.project.path, t))) return reply.code(400).send({ error: 'nothing to merge: commit the chat\'s changes first' });
    const requests = store.listTurns(c.conv.id).slice(-5).map((r) => r.prompt);
    const prompt = await mrDescriptionPrompt(c.project.path, t.branch, { name: t.base.name ?? 'the current branch', ref: t.base.ref }, requests,
      store.getKv('mr_prompt') || DEFAULT_MR_PROMPT);
    try {
      const answer = await dispatcher.ask(c.conv.backend, prompt, { cwd: c.cwd }); // Settings' default model and effort, not the chat's
      const description = cleanMessage(answer);
      // `description` is for pasting into a Merge Request; `message` is the same as title line + body, for Create Merge Request.
      return description ? { description, message: toCommitMessage(description) } : reply.code(502).send({ error: 'the agent gave an empty answer' });
    } catch (e) {
      return reply.code(502).send({ error: `could not draft a description: ${(e as Error).message}` });
    }
  });

  // Pick the branch this chat's Merge Request goes into: a local branch or one on the default remote. An empty `base`
  // goes back to the usual one (see mrTarget). Refused while this branch's Merge Request is open (409).
  app.put<{ Params: { id: string }; Body: { base: string } }>('/api/conversations/:id/git/mr-base', {
    schema: { body: { type: 'object', required: ['base'], additionalProperties: false, properties: { base: { type: 'string', maxLength: 200 } } } },
  }, async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    if (c.project.sandbox === 'read-only' && req.user?.role !== 'admin') return reply.code(403).send({ error: 'read-only project: admin only' });
    if (!(await git.isRepo(c.project.path))) return reply.code(400).send({ error: 'not a git repository' });
    const name = req.body.base.trim();
    const branch = c.conv.worktree && c.conv.branch ? c.conv.branch : await git.currentBranch(c.project.path);
    if (name) {
      if (name === branch) return reply.code(400).send({ error: `${name} is the branch the Merge Request comes from` });
      if (!(await git.branchRef(c.project.path, name))) return reply.code(400).send({ error: `no such branch: ${name}` });
    }
    // An open Merge Request keeps the branch it was opened into; once merged or closed, the next one may go elsewhere.
    const url = branch && prFor(c.conv, branch);
    if (url) {
      const cli = prCli(url);
      const state = cli && (await prStatus(cli.forge, cli.command, c.cwd, url).then((p) => p.state, () => null));
      if (state !== 'merged' && state !== 'closed') {
        return reply.code(409).send({ error: `a Merge Request is already open for ${branch}: change its target on the forge, or merge or close it first` });
      }
    }
    store.setMrBase(c.conv.id, name || null);
    const t = await mrTarget(store.getConversation(c.conv.id)!, c.project);
    return { base: t?.base.name ?? null, usual: t?.usual ?? null, picked: t?.picked ?? false };
  });

  // Push the chat's branch and open a Merge Request (GitLab, via `glab`) or pull request (GitHub, via `gh`) from it into
  // its target (see mrTarget), with the server's own CLI login. Without a title, the last commit's subject.
  // The body is optional, so it is checked here rather than by a schema.
  app.post<{ Params: { id: string }; Body: { title?: unknown; body?: unknown } | undefined }>('/api/conversations/:id/git/pull-request', async (req, reply) => {
    const { title: rawTitle = '', body: rawBody = '' } = req.body ?? {};
    if (typeof rawTitle !== 'string' || rawTitle.length > 300) return reply.code(400).send({ error: 'title must be a string of at most 300 characters' });
    if (typeof rawBody !== 'string' || rawBody.length > 60_000) return reply.code(400).send({ error: 'body must be a string of at most 60000 characters' });
    const c = load(req.params.id, reply);
    if (!c) return;
    const t = await mrTarget(c.conv, c.project);
    if (!t) return reply.code(400).send({ error: noTarget });
    const { branch, base: { name: base } } = t;
    if (!base) return reply.code(400).send({ error: 'this chat was branched from a detached HEAD: there is no branch to merge into' });
    if (!mayWrite(req, reply, c.project, [c.cwd])) return;
    if (!(await aheadOf(c.project.path, t))) return reply.code(400).send({ error: `nothing to propose: ${branch} has no commits that ${base} lacks` });

    const push = await git.push(c.cwd);
    if (!push.pushed) return reply.code(400).send({ error: push.error ? `push failed: ${push.error}` : 'the repository has no remote to open a Merge Request on' });
    const remote = push.pushed.slice(0, push.pushed.indexOf('/'));
    const url = (await git.git(c.cwd, ['remote', 'get-url', remote]).catch(() => '')).trim();
    // A host named neither github nor gitlab: whichever CLI the caller is signed in to it with.
    let target = await remoteRepo(url, cfg.forge);
    const r = !target ? parseRemote(url) : null;
    if (r) {
      const host = r.ssh ? await sshHostName(r.host) : r.host;
      const forge = await users.auth(req.user?.id ?? null).forgeForHost(host);
      if (forge) target = await remoteRepo(url, forge);
    }
    if (!target) {
      return reply.code(400).send({ error: `cannot tell whether ${url || remote} is GitHub or GitLab: sign gh or glab in to that host (Settings → Git & forges), or set GIT_FORGE` });
    }
    const { forge, repo } = target;

    const title = rawTitle.trim() || (await git.git(c.cwd, ['log', '-1', '--format=%s', branch])).trim();
    try {
      const command = (forge === 'github' ? cfg.ghCommand : cfg.glabCommand) ?? [forge === 'github' ? 'gh' : 'glab'];
      const pr = await createPullRequest({ forge, command, cwd: c.cwd, repo, branch, base, title, body: rawBody.trim() });
      store.setPrUrl(c.conv.id, pr.url, branch);
      store.setMrBase(c.conv.id, base); // the target stays what it was opened into, even if the usual one changes
      return { ...pr, forge, push };
    } catch (e) { return gitFailed(reply, e); }
  });

  app.post<{ Params: { id: string }; Body: { paths: string[] } }>('/api/conversations/:id/git/revert', {
    schema: { body: { type: 'object', required: ['paths'], additionalProperties: false,
      properties: { paths: { ...pathsSchema, minItems: 1 } } } },
  }, async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c || !mayWrite(req, reply, c.project, [c.cwd])) return;
    const files = await pick(c.cwd, req.body.paths, reply);
    if (!files) return;
    try {
      await git.revert(c.cwd, files);
      return reply.code(204).send();
    } catch (e) { return gitFailed(reply, e); }
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/git/discard', async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c || !mayWrite(req, reply, c.project, [c.cwd])) return;
    if (!(await git.isRepo(c.cwd))) return reply.code(400).send({ error: 'not a git repository' });
    try {
      await git.discardAll(c.cwd);
      return reply.code(204).send();
    } catch (e) { return gitFailed(reply, e); }
  });

  // Fast-forward the chat's folder from the remote. Never merges: a branch that has gone its own way is refused.
  app.post<{ Params: { id: string } }>('/api/conversations/:id/git/pull', async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c || !mayWrite(req, reply, c.project, [c.cwd])) return;
    if (!(await git.isRepo(c.cwd))) return reply.code(400).send({ error: 'not a git repository' });
    try {
      return await git.pull(c.cwd);
    } catch (e) { return gitFailed(reply, e); }
  });

  // The commit history of every branch, newest first, for the History graph. Changes nothing.
  app.get<{ Params: { id: string }; Querystring: { limit?: number } }>('/api/conversations/:id/git/log', {
    schema: { querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 2000 } } } },
  }, async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    if (!(await git.isRepo(c.cwd))) return reply.code(400).send({ error: 'not a git repository' });
    return git.log(c.cwd, req.query.limit ?? 150);
  });

  // One commit from the History: its message and the files it changed, then a file's diff. Only files the commit changed
  // may be named. Changes nothing.
  app.get<{ Params: { id: string; hash: string } }>('/api/conversations/:id/git/commits/:hash', async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    return (await git.commitDetail(c.cwd, req.params.hash)) ?? reply.code(404).send({ error: 'no such commit' });
  });

  app.get<{ Params: { id: string; hash: string }; Querystring: { path?: string } }>('/api/conversations/:id/git/commits/:hash/diff', {
    schema: { querystring: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } } } },
  }, async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    const commit = await git.commitDetail(c.cwd, req.params.hash);
    if (!commit) return reply.code(404).send({ error: 'no such commit' });
    const file = commit.files.find((f) => f.path === req.query.path);
    if (!file) return reply.code(400).send({ error: `not changed in this commit: ${req.query.path}` });
    return { diff: await git.commitFileDiff(c.cwd, commit, file) };
  });

  // `?fetch=1` asks the remote for its branches first.
  app.get<{ Params: { id: string }; Querystring: { fetch?: string } }>('/api/conversations/:id/git/branches', async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    if (!(await git.isRepo(c.cwd))) return reply.code(400).send({ error: 'not a git repository' });
    return git.branches(c.cwd, req.query.fetch === '1');
  });

  // Switch the project folder to another branch, or create one (from `from`, default the current HEAD) and switch to it.
  // A worktree chat stays on its own branch: that is what its Merge Request and its cleanup are about.
  app.post<{ Params: { id: string }; Body: { name: string; create?: boolean; from?: string } }>('/api/conversations/:id/git/branch', {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 }, create: { type: 'boolean' }, from: { type: 'string', minLength: 1, maxLength: 200 } } } },
  }, async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    if (c.conv.worktree) return reply.code(400).send({ error: 'a worktree chat stays on its own branch: use a chat in the project folder to switch branches' });
    if (!mayWrite(req, reply, c.project, [c.cwd])) return;
    if (!(await git.isRepo(c.cwd))) return reply.code(400).send({ error: 'not a git repository' });
    const name = req.body.name.trim();
    try {
      await git.switchBranch(c.cwd, name, { create: req.body.create, from: req.body.from?.trim() || undefined });
      return { branch: name };
    } catch (e) { return gitFailed(reply, e); }
  });

  // Rename a worktree chat's own branch (`dalang/<id>` says little on the remote). A pushed one moves there too; one with
  // a Merge Request open stays, since the Merge Request would be left pointing at the old name.
  app.post<{ Params: { id: string }; Body: { name: string } }>('/api/conversations/:id/git/branch/rename', {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 } } } },
  }, async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    const from = c.conv.branch;
    if (!c.conv.worktree || !from) return reply.code(400).send({ error: "only a worktree chat's own branch is renamed here" });
    if (prFor(c.conv, from)) return reply.code(400).send({ error: 'a Merge Request is open for this branch: renaming it would leave that behind' });
    if (!mayWrite(req, reply, c.project, [c.cwd])) return;
    const name = req.body.name.trim();
    if (name === from) return { branch: name, push: null };
    try {
      const push = await git.renameBranch(c.cwd, from, name);
      store.setBranch(c.conv.id, name);
      return { branch: name, push };
    } catch (e) { return gitFailed(reply, e); }
  });

  // Delete a local branch; the remote keeps its copy. One with commits found nowhere else needs `force` (409 without).
  app.post<{ Params: { id: string }; Body: { name: string; force?: boolean } }>('/api/conversations/:id/git/branch/delete', {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 }, force: { type: 'boolean' } } } },
  }, async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    if (c.conv.worktree) return reply.code(400).send({ error: 'manage branches from a chat in the project folder' });
    if (!mayWrite(req, reply, c.project, [c.cwd])) return;
    if (!(await git.isRepo(c.cwd))) return reply.code(400).send({ error: 'not a git repository' });
    try {
      await git.deleteBranch(c.cwd, req.body.name.trim(), req.body.force);
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof git.UnmergedError) return reply.code(409).send({ error: e.message, unmerged: true });
      return gitFailed(reply, e);
    }
  });

  /** The chat and its folder for a route that changes files there, or null after replying (404, 403, 409, 400). */
  const writable = async (req: { params: { id: string }; user?: { role: string } }, reply: Reply) => {
    const c = load(req.params.id, reply);
    if (!c || !mayWrite(req, reply, c.project, [c.cwd])) return null;
    if (!(await git.isRepo(c.cwd))) { reply.code(400).send({ error: 'not a git repository' }); return null; }
    return c;
  };
  const readable = async (req: { params: { id: string } }, reply: Reply) => {
    const c = load(req.params.id, reply);
    if (!c) return null;
    if (!(await git.isRepo(c.cwd))) { reply.code(400).send({ error: 'not a git repository' }); return null; }
    return c;
  };

  // Ask the remote what it has, so ahead/behind counts and the branch lists are current.
  app.post<{ Params: { id: string } }>('/api/conversations/:id/git/fetch', async (req, reply) => {
    const c = await readable(req, reply);
    if (!c) return;
    try {
      return { remote: await git.fetchRemote(c.cwd) };
    } catch (e) { return gitFailed(reply, e); }
  });

  // Bring the branch up to date, merged or rebased: from its own upstream (`upstream`, for when it went apart from the
  // remote and a pull cannot fast-forward), or from the branch a Merge Request from here would go into (`base`). The
  // remote is fetched first. Conflicts are not an error: the answer lists them, and the operation waits.
  app.post<{ Params: { id: string }; Body: { from: 'upstream' | 'base'; mode: 'merge' | 'rebase' } }>('/api/conversations/:id/git/sync', {
    schema: { body: { type: 'object', required: ['from', 'mode'], additionalProperties: false, properties: {
      from: { enum: ['upstream', 'base'] }, mode: { enum: ['merge', 'rebase'] } } } },
  }, async (req, reply) => {
    const c = await writable(req, reply);
    if (!c) return;
    try {
      await git.fetchRemote(c.cwd).catch(() => null); // offline: go on with what was fetched last
      const onto = req.body.from === 'upstream' ? await git.upstreamRef(c.cwd) : (await syncBase(c))?.ref;
      if (!onto) {
        return reply.code(400).send({ error: req.body.from === 'upstream' ? 'this branch has no remote branch to sync with yet' : 'there is no base branch to sync with' });
      }
      return { ...(await git.integrate(c.cwd, onto, req.body.mode)), onto };
    } catch (e) { return gitFailed(reply, e); }
  });

  // Settle a conflicted file: this branch's side, the incoming side, or "resolved" once edited by hand.
  app.post<{ Params: { id: string }; Body: { path: string; take: 'mine' | 'theirs' | 'resolved' } }>('/api/conversations/:id/git/conflicts/resolve', {
    schema: { body: { type: 'object', required: ['path', 'take'], additionalProperties: false, properties: {
      path: { type: 'string', minLength: 1 }, take: { enum: ['mine', 'theirs', 'resolved'] } } } },
  }, async (req, reply) => {
    const c = await writable(req, reply);
    if (!c) return;
    try {
      await git.resolveConflict(c.cwd, req.body.path, req.body.take);
      return reply.code(204).send();
    } catch (e) { return gitFailed(reply, e); }
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/git/conflicts/continue', async (req, reply) => {
    const c = await writable(req, reply);
    if (!c) return;
    try {
      return await git.continueOperation(c.cwd);
    } catch (e) { return gitFailed(reply, e); }
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/git/conflicts/abort', async (req, reply) => {
    const c = await writable(req, reply);
    if (!c) return;
    try {
      return { aborted: await git.abortOperation(c.cwd) };
    } catch (e) { return gitFailed(reply, e); }
  });

  // Copy one commit onto the checked-out branch, or add one undoing it. Either may stop on conflicts.
  for (const how of ['cherry-pick', 'revert'] as const) {
    app.post<{ Params: { id: string; hash: string } }>(`/api/conversations/:id/git/commits/:hash/${how}`, async (req, reply) => {
      const c = await writable(req, reply);
      if (!c) return;
      try {
        return await git.applyCommit(c.cwd, req.params.hash, how);
      } catch (e) { return gitFailed(reply, e); }
    });
  }

  // Stashes: uncommitted work put aside, to bring back later (here or in another chat of the same repository).
  app.get<{ Params: { id: string } }>('/api/conversations/:id/git/stashes', async (req, reply) => {
    const c = await readable(req, reply);
    if (!c) return;
    return git.stashes(c.cwd);
  });

  // The body (a message) is optional, so it is checked here rather than by a schema.
  app.post<{ Params: { id: string }; Body: { message?: unknown } | undefined }>('/api/conversations/:id/git/stashes', async (req, reply) => {
    const message = req.body?.message ?? '';
    if (typeof message !== 'string' || message.length > 500) return reply.code(400).send({ error: 'message must be a string of at most 500 characters' });
    const c = await writable(req, reply);
    if (!c) return;
    try {
      await git.stashPush(c.cwd, message.trim());
      return reply.code(204).send();
    } catch (e) { return gitFailed(reply, e); }
  });

  const stashIndex = { type: 'object', required: ['index'], properties: { index: { type: 'integer', minimum: 0, maximum: 10_000 } } };

  // `pop` also drops it once its changes are back (it stays if they clashed). The body is optional.
  app.post<{ Params: { id: string; index: number }; Body: { pop?: unknown } | undefined }>('/api/conversations/:id/git/stashes/:index/apply', {
    schema: { params: { ...stashIndex, required: ['id', 'index'], properties: { ...stashIndex.properties, id: { type: 'string' } } } },
  }, async (req, reply) => {
    const c = await writable(req, reply);
    if (!c) return;
    try {
      return await git.stashApply(c.cwd, req.params.index, req.body?.pop === true);
    } catch (e) { return gitFailed(reply, e); }
  });

  app.post<{ Params: { id: string; index: number } }>('/api/conversations/:id/git/stashes/:index/drop', {
    schema: { params: { ...stashIndex, required: ['id', 'index'], properties: { ...stashIndex.properties, id: { type: 'string' } } } },
  }, async (req, reply) => {
    const c = await writable(req, reply);
    if (!c) return;
    try {
      await git.stashDrop(c.cwd, req.params.index);
      return reply.code(204).send();
    } catch (e) { return gitFailed(reply, e); }
  });

  app.get<{ Params: { id: string; index: number }; Querystring: { path: string } }>('/api/conversations/:id/git/stashes/:index/diff', {
    schema: { params: { ...stashIndex, required: ['id', 'index'], properties: { ...stashIndex.properties, id: { type: 'string' } } },
      querystring: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } } } },
  }, async (req, reply) => {
    const c = await readable(req, reply);
    if (!c) return;
    try {
      return { diff: await git.stashFileDiff(c.cwd, req.params.index, req.query.path) };
    } catch (e) { return gitFailed(reply, e); }
  });

  /** A path inside the chat's folder as the caller gave it, relative and with forward slashes, or null after a 400. */
  const repoPath = (path: string, reply: Reply) => {
    const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!p || p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').some((s) => s === '..' || s === '') || p.startsWith('-')) {
      reply.code(400).send({ error: `not a path inside the folder: ${path}` });
      return null;
    }
    return p;
  };
  const fileQuery = { querystring: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } } } };

  // Who last changed each line of a file, for the code editor's blame view. Changes nothing.
  app.get<{ Params: { id: string }; Querystring: { path: string } }>('/api/conversations/:id/git/blame', { schema: fileQuery }, async (req, reply) => {
    const c = await readable(req, reply);
    if (!c) return;
    const path = repoPath(req.query.path, reply);
    if (!path) return;
    try {
      return await git.blame(c.cwd, path);
    } catch (e) { return gitFailed(reply, e); }
  });

  // The commits that changed one file, following renames. Changes nothing.
  app.get<{ Params: { id: string }; Querystring: { path: string } }>('/api/conversations/:id/git/file-log', { schema: fileQuery }, async (req, reply) => {
    const c = await readable(req, reply);
    if (!c) return;
    const path = repoPath(req.query.path, reply);
    if (!path) return;
    return { commits: await git.fileLog(c.cwd, path) };
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/git/tags', async (req, reply) => {
    const c = await readable(req, reply);
    if (!c) return;
    return git.tags(c.cwd);
  });

  // Tag a commit (annotated with a message), and push the tag when asked.
  app.post<{ Params: { id: string }; Body: { name: string; hash: string; message?: string; push?: boolean } }>('/api/conversations/:id/git/tags', {
    schema: { body: { type: 'object', required: ['name', 'hash'], additionalProperties: false, properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 }, hash: { type: 'string', minLength: 4, maxLength: 64 },
      message: { type: 'string', maxLength: 10_000 }, push: { type: 'boolean' } } } },
  }, async (req, reply) => {
    const c = await writable(req, reply);
    if (!c) return;
    try {
      const push = await git.createTag(c.cwd, req.body.name.trim(), req.body.hash, { message: req.body.message?.trim() || undefined, push: req.body.push });
      return { tag: req.body.name.trim(), push };
    } catch (e) { return gitFailed(reply, e); }
  });

  app.post<{ Params: { id: string }; Body: { name: string; remote?: boolean } }>('/api/conversations/:id/git/tags/delete', {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 }, remote: { type: 'boolean' } } } },
  }, async (req, reply) => {
    const c = await writable(req, reply);
    if (!c) return;
    try {
      return { push: await git.deleteTag(c.cwd, req.body.name, !!req.body.remote) };
    } catch (e) { return gitFailed(reply, e); }
  });

  // Two branches, tags or commits compared as a Merge Request from `head` into `base` would be. Changes nothing.
  const refsQuery = { type: 'object', required: ['base', 'head'], properties: {
    base: { type: 'string', minLength: 1, maxLength: 300 }, head: { type: 'string', minLength: 1, maxLength: 300 }, path: { type: 'string', minLength: 1 } } };
  app.get<{ Params: { id: string }; Querystring: { base: string; head: string } }>('/api/conversations/:id/git/compare', {
    schema: { querystring: refsQuery },
  }, async (req, reply) => {
    const c = await readable(req, reply);
    if (!c) return;
    try {
      return await git.compare(c.cwd, req.query.base, req.query.head);
    } catch (e) { return gitFailed(reply, e); }
  });

  app.get<{ Params: { id: string }; Querystring: { base: string; head: string; path?: string } }>('/api/conversations/:id/git/compare/diff', {
    schema: { querystring: { ...refsQuery, required: ['base', 'head', 'path'] } },
  }, async (req, reply) => {
    const c = await readable(req, reply);
    if (!c) return;
    try {
      const { files } = await git.compare(c.cwd, req.query.base, req.query.head);
      const file = files.find((f) => f.path === req.query.path);
      if (!file) return reply.code(400).send({ error: `not changed between them: ${req.query.path}` });
      return { diff: await git.compareFileDiff(c.cwd, req.query.base, req.query.head, file) };
    } catch (e) { return gitFailed(reply, e); }
  });

  // Turn checkpoints: the folder before and after each agent turn (see saveCheckpoint), newest turn first, with what
  // the turn changed. Only turns that have both are listed.
  const MAX_CHECKPOINTS = 30;
  const turnCheckpoints = async (cwd: string, convId: string, turnId: number) => {
    const [before, after] = await Promise.all([git.checkpoint(cwd, convId, `${turnId}-before`), git.checkpoint(cwd, convId, `${turnId}-after`)]);
    return before && after ? { before, after } : null;
  };
  app.get<{ Params: { id: string } }>('/api/conversations/:id/git/checkpoints', async (req, reply) => {
    const c = await readable(req, reply);
    if (!c) return;
    const out = [];
    for (const t of store.listTurns(c.conv.id).reverse()) {
      if (out.length >= MAX_CHECKPOINTS) break;
      const cp = await turnCheckpoints(c.cwd, c.conv.id, t.id);
      if (!cp) continue;
      out.push({ turn: t.id, prompt: t.prompt, status: t.status, started_at: t.started_at, ended_at: t.ended_at, files: await git.changedBetween(c.cwd, cp.before, cp.after) });
    }
    return { checkpoints: out, undo: !!(await git.checkpoint(c.cwd, c.conv.id, 'undo')) };
  });

  app.get<{ Params: { id: string; turn: number }; Querystring: { path: string } }>('/api/conversations/:id/git/checkpoints/:turn/diff', {
    schema: { params: { type: 'object', required: ['id', 'turn'], properties: { id: { type: 'string' }, turn: { type: 'integer', minimum: 1 } } },
      querystring: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } } } },
  }, async (req, reply) => {
    const c = await readable(req, reply);
    if (!c) return;
    const cp = await turnCheckpoints(c.cwd, c.conv.id, req.params.turn);
    if (!cp) return reply.code(404).send({ error: 'no checkpoint for that turn' });
    const file = (await git.changedBetween(c.cwd, cp.before, cp.after)).find((f) => f.path === req.query.path);
    if (!file) return reply.code(400).send({ error: `not changed in that turn: ${req.query.path}` });
    return { diff: await git.diffBetween(c.cwd, cp.before, cp.after, file) };
  });

  // Put the files back as they were before (or right after) a turn. The folder as it is now is kept first, so
  // /checkpoints/undo can take the restore back.
  app.post<{ Params: { id: string; turn: number }; Body: { to: 'before' | 'after' } }>('/api/conversations/:id/git/checkpoints/:turn/restore', {
    schema: { params: { type: 'object', required: ['id', 'turn'], properties: { id: { type: 'string' }, turn: { type: 'integer', minimum: 1 } } },
      body: { type: 'object', required: ['to'], additionalProperties: false, properties: { to: { enum: ['before', 'after'] } } } },
  }, async (req, reply) => {
    const c = await writable(req, reply);
    if (!c) return;
    const hash = await git.checkpoint(c.cwd, c.conv.id, `${req.params.turn}-${req.body.to}`);
    if (!hash) return reply.code(404).send({ error: 'no checkpoint for that turn' });
    try {
      const r = await git.restoreSnapshot(c.cwd, hash);
      await git.keepUndo(c.cwd, c.conv.id, r.undo);
      return { files: r.files };
    } catch (e) { return gitFailed(reply, e); }
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/git/checkpoints/undo', async (req, reply) => {
    const c = await writable(req, reply);
    if (!c) return;
    const hash = await git.checkpoint(c.cwd, c.conv.id, 'undo');
    if (!hash) return reply.code(404).send({ error: 'there is no restore to undo' });
    try {
      const r = await git.restoreSnapshot(c.cwd, hash);
      await git.keepUndo(c.cwd, c.conv.id, r.undo); // undoing the undo puts the restore back
      return { files: r.files };
    } catch (e) { return gitFailed(reply, e); }
  });

  /** The forge CLI for this chat's pull request / Merge Request, read from its address. */
  const prCli = (url: string) => {
    const forge = parsePrUrl(url)?.forge ?? cfg.forge ?? null;
    if (!forge) return null;
    return { forge, command: (forge === 'github' ? cfg.ghCommand : cfg.glabCommand) ?? [forge === 'github' ? 'gh' : 'glab'] };
  };
  const openPr = async (c: { conv: Conversation; project: Project }) => {
    const t = await mrTarget(c.conv, c.project);
    return t ? prFor(c.conv, t.branch) : null;
  };

  // Where the chat's pull request / Merge Request stands: state, checks, review and comments, from the forge.
  app.get<{ Params: { id: string } }>('/api/conversations/:id/git/pull-request', async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    const url = await openPr(c);
    if (!url) return reply.code(404).send({ error: 'this chat has no Merge Request open' });
    const cli = prCli(url);
    if (!cli) return reply.code(400).send({ error: `cannot tell whether ${url} is GitHub or GitLab` });
    try {
      return { ...(await prStatus(cli.forge, cli.command, c.cwd, url)), forge: cli.forge };
    } catch (e) { return gitFailed(reply, e); }
  });

  // Merge the chat's pull request / Merge Request on the forge (merge commit, squash or rebase).
  app.post<{ Params: { id: string }; Body: { method: MergeMethod } }>('/api/conversations/:id/git/pull-request/merge', {
    schema: { body: { type: 'object', required: ['method'], additionalProperties: false, properties: { method: { enum: ['merge', 'squash', 'rebase'] } } } },
  }, async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c) return;
    if (c.project.sandbox === 'read-only' && req.user?.role !== 'admin') return reply.code(403).send({ error: 'read-only project: admin only' });
    const url = await openPr(c);
    if (!url) return reply.code(404).send({ error: 'this chat has no Merge Request open' });
    const cli = prCli(url);
    if (!cli) return reply.code(400).send({ error: `cannot tell whether ${url} is GitHub or GitLab` });
    try {
      await mergePr(cli.forge, cli.command, c.cwd, url, req.body.method);
      return { ...(await prStatus(cli.forge, cli.command, c.cwd, url)), forge: cli.forge };
    } catch (e) { return gitFailed(reply, e); }
  });
}
