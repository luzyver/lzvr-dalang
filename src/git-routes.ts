import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from './config.js';
import type { Dispatcher } from './dispatcher.js';
import { createPullRequest, remoteRepo } from './forge.js';
import * as git from './git.js';
import type { Conversation, Project, Store } from './store.js';

/**
 * A new chat with its own worktree: a branch `dalang/<id>` from the project's HEAD, checked out under
 * `<STATE_DIR>/worktrees/<chat id>`, so parallel chats in one project never write over each other's files.
 */
export async function createWorktreeChat(store: Store, cfg: Config, project: Project): Promise<Conversation> {
  if (!(await git.isRepo(project.path))) throw new git.GitError('the project folder is not a git repository');
  const conv = store.createConversation(project.id);
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
 * Remove the worktrees of chats that are being deleted. Call after cancelling their turns: it waits for each agent to
 * exit first, since its files are still open until then. Never throws (a leftover folder is only logged).
 */
export async function dropWorktrees(dispatcher: Dispatcher, project: Project, convs: Conversation[]): Promise<void> {
  for (const c of convs) {
    if (!c.worktree) continue;
    for (let i = 0; i < 200 && dispatcher.isRunning(c.id); i++) await new Promise((r) => setTimeout(r, 50));
    await git.removeWorktree(project.path, c.worktree, c.branch).catch((e) => console.error(`could not remove worktree ${c.worktree}`, e));
  }
}

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

/** What a chat's Merge Request would go from and into. `base.name` is null when there is no branch to open one into. */
export interface MrTarget { branch: string; base: { name: string | null; ref: string } }

/**
 * A worktree chat proposes its own branch into the branch it started from. A plain chat proposes whatever branch the
 * project folder has checked out into the remote's default branch, unless that is the default branch itself.
 */
export async function mrTarget(conv: Conversation, project: Project): Promise<MrTarget | null> {
  if (conv.worktree && conv.branch) return { branch: conv.branch, base: { name: conv.base_branch, ref: conv.base_branch ?? 'HEAD' } };
  const branch = await git.currentBranch(project.path);
  if (!branch) return null;
  const base = await git.defaultBranch(project.path);
  return base && base.name !== branch ? { branch, base } : null;
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

export function gitRoutes(app: FastifyInstance, deps: { store: Store; dispatcher: Dispatcher; cfg: Config }): void {
  const { store, dispatcher, cfg } = deps;
  const notFound = (reply: Reply) => reply.code(404).send({ error: 'not found' });

  /** The chat, its project and the folder git runs in, or null after replying 404. */
  const load = (id: string, reply: Reply) => {
    const conv = store.getConversation(id);
    const project = conv && store.getProject(conv.project_id);
    if (!conv || !project) { notFound(reply); return null; }
    return { conv, project, cwd: conv.worktree ?? project.path };
  };

  /** Any chat whose agent works in one of these folders and is running right now. */
  const busy = (project: Project, dirs: string[]) =>
    store.listConversations(project.id).some((c) => dirs.includes(c.worktree ?? project.path) && dispatcher.isRunning(c.id));

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

  /** The Merge Request this chat opened for `branch`; rows from before `pr_branch` existed are worktree chats only. */
  const prFor = (conv: Conversation, branch: string) =>
    (conv.pr_branch ? conv.pr_branch === branch : !!conv.worktree) ? conv.pr_url : null;

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
    // Commits on the branch that its target (or, if a worktree had none, the project folder's HEAD) does not have yet.
    const mr = t && { branch: t.branch, base: t.base.name, ahead: await aheadOf(c.project.path, t), pr: prFor(c.conv, t.branch) };
    return { ...s, worktree: c.conv.worktree ? mr : null, mr };
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

  app.post<{ Params: { id: string }; Body: { message: string; paths?: string[] } }>('/api/conversations/:id/git/commit', {
    schema: { body: { type: 'object', required: ['message'], additionalProperties: false,
      properties: { message: { type: 'string', minLength: 1, maxLength: 10_000, pattern: '\\S' }, paths: pathsSchema } } },
  }, async (req, reply) => {
    const c = load(req.params.id, reply);
    if (!c || !mayWrite(req, reply, c.project, [c.cwd])) return;
    const paths = req.body.paths ?? [];
    if (paths.length && !(await pick(c.cwd, paths, reply))) return;
    // A commit goes straight to the remote too (a worktree chat's branch gets one there, ready for a Merge Request).
    try {
      const commit = await git.commit(c.cwd, req.body.message, paths);
      return { commit, push: await git.push(c.cwd) };
    } catch (e) { return gitFailed(reply, e); }
  });

  // Draft a commit message with the chat's own agent CLI and model. Changes nothing, so it is not limited like the rest.
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
      const answer = await dispatcher.ask(c.conv.backend, prompt, { cwd: c.cwd, model: c.conv.model, effort: c.conv.effort });
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
      const answer = await dispatcher.ask(c.conv.backend, prompt, { cwd: c.cwd, model: c.conv.model, effort: c.conv.effort });
      const description = cleanMessage(answer);
      // `description` is for pasting into a Merge Request; `message` is the same as title line + body, for Create Merge Request.
      return description ? { description, message: toCommitMessage(description) } : reply.code(502).send({ error: 'the agent gave an empty answer' });
    } catch (e) {
      return reply.code(502).send({ error: `could not draft a description: ${(e as Error).message}` });
    }
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
    const target = await remoteRepo(url, cfg.forge);
    if (!target) return reply.code(400).send({ error: `cannot tell whether ${url || remote} is GitHub or GitLab: set GIT_FORGE` });
    const { forge, repo } = target;

    const title = rawTitle.trim() || (await git.git(c.cwd, ['log', '-1', '--format=%s', branch])).trim();
    try {
      const command = (forge === 'github' ? cfg.ghCommand : cfg.glabCommand) ?? [forge === 'github' ? 'gh' : 'glab'];
      const pr = await createPullRequest({ forge, command, cwd: c.cwd, repo, branch, base, title, body: rawBody.trim() });
      store.setPrUrl(c.conv.id, pr.url, branch);
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
}
