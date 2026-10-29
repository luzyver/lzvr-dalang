import { changedBetween, diffBetween, type GitFile } from './git.js';
import type { Backend } from './util.js';

/**
 * The automatic reviewer: after a turn of a person's chat that changed files, a second agent (a read-only sub-chat)
 * checks the work against the request. When it finds problems they go back to the chat as a new prompt, so its agent
 * fixes them; `maxRounds` limits how often that happens per request of the person.
 * `backend` '' = the chat's own; `model` and `effort` '' = that backend's defaults (they only apply with a set backend).
 */
export interface ReviewerPolicy { enabled: boolean; backend: '' | Backend; model: string; effort: string; maxRounds: number; guide: string }
export const REVIEWER_DEFAULTS: ReviewerPolicy = { enabled: false, backend: '', model: '', effort: '', maxRounds: 2, guide: '' };

/**
 * Per person's chat, the request its reviewer checks: where it started (a checkpoint), how many reviews it had, and the
 * reviewer chat whose answer is awaited ('' = none). Kept in the database, so a review a restart cut off still reports.
 */
export interface ReviewState { request: string; base: string; rounds: number; reviewer: string }

/** Which review of which request a review prompt asks for: a reviewer's late answer must not count for a newer one. */
export const reviewKey = (r: Pick<ReviewState, 'base' | 'rounds'>) => `${r.base}/${r.rounds}`;
/** The review a prompt from buildReviewPrompt asks for, or null for any other prompt. */
export function promptReview(prompt: string): { key: string; round: number } | null {
  const m = /^You are the reviewer of another agent's work in this repository \(round (\d+), review ([^\s)]+)\)/.exec(prompt);
  return m ? { round: Number(m[1]), key: m[2]! } : null;
}

/** The flag on a reviewer's own chat (conversations.role). */
export const REVIEWER_ROLE = 'reviewer';
export const REVIEWER_TITLE = 'Reviewer';

/** How much of the diff goes into the review prompt; the reviewer can read the rest itself. */
const DIFF_MAX = 60_000;
const ANSWER_MAX = 8_000;
/** Files whose diff goes into the prompt; the list names them all. */
const DIFF_FILES = 40;

export const REVIEWER_GUIDE = `Review strictly but fairly. Check that the change does what was asked, is correct (logic, edge cases,
errors, security), does not break existing behaviour, follows the conventions of the surrounding code, and that nothing
asked for is missing. Ignore matters of taste. Do not change any file: you only report.`;

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n[cut here]` : s);

/** The change between two checkpoints: its files, and the diffs of the first of them. */
export async function collectChange(cwd: string, base: string, after: string): Promise<{ files: GitFile[]; diffs: string[] }> {
  const files = await changedBetween(cwd, base, after);
  const diffs: string[] = [];
  for (const f of files.slice(0, DIFF_FILES)) {
    diffs.push(`### ${f.path}\n${await diffBetween(cwd, base, after, f).catch(() => '(no diff)')}`);
  }
  return { files, diffs };
}

/** What the reviewer is asked: the person's request, the agent's answer, and the change between the two checkpoints. */
export function buildReviewPrompt(o: {
  request: string; answer: string; base: string; after: string; files: GitFile[]; diffs: string[]; guide?: string; round: number; key: string;
}): string {
  const list = o.files.map((f) => `${f.status} ${f.from ? `${f.from} -> ` : ''}${f.path}`).join('\n');
  return `You are the reviewer of another agent's work in this repository (round ${o.round}, review ${o.key}).\n\n`
    + `${o.guide?.trim() || REVIEWER_GUIDE}\n\n`
    + `The request it worked on:\n\n${cut(o.request, ANSWER_MAX)}\n\n`
    + `Its last answer:\n\n${cut(o.answer, ANSWER_MAX) || '(none)'}\n\n`
    + `Changed files (git checkpoints ${o.base}..${o.after}; \`git diff ${o.base} ${o.after}\` shows all of it):\n${list}\n\n`
    + `Diff:\n\n${cut(o.diffs.join('\n'), DIFF_MAX)}\n\n`
    + 'Read the files themselves where the diff is not enough. Answer with LGTM alone on the first line when the work is '
    + 'fine. Otherwise put ISSUES on the first line, then a numbered list: each issue with file:line, what is wrong and '
    + 'what to do instead. List only real problems.';
}

/** The reviewer's verdict from its answer: ISSUES only when it says so on the first line; anything else passes. */
export function parseVerdict(answer: string): { ok: boolean; issues: string } {
  const text = answer.trim();
  const first = text.split('\n', 1)[0]!.replace(/[*#_`\s]/g, '').toUpperCase();
  if (first.startsWith('ISSUES')) return { ok: false, issues: text.slice(text.indexOf('\n') + 1 || text.length).trim() };
  return { ok: true, issues: '' };
}

/**
 * What goes back to the reviewed chat when the reviewer found problems. `earlier`: the review of a change before the
 * person's latest request (that came while the reviewer still worked), so some issues may be fixed or moot by now.
 */
const EARLIER = '[Reviewer] An automatic review of a change of yours from before the latest request';

/** Whether a queued prompt is the findings of a review that belongs to an earlier request (see reviewerMessage). */
export const isEarlierReview = (prompt: string) => prompt.startsWith(EARLIER);

export function reviewerMessage(o: { reviewer: string; issues: string; round: number; maxRounds: number; earlier?: boolean }): string {
  return `${o.earlier ? EARLIER : '[Reviewer] An automatic review of your last change'} (round ${o.round} of ${o.maxRounds}, reviewer chat ${o.reviewer}) `
    + `found problems:\n\n${cut(o.issues, ANSWER_MAX) || '(no details given)'}\n\n`
    + (o.earlier ? 'First check whether each one still applies to the code as it is now. ' : '')
    + 'Fix the ones that are real. If one is wrong, say why instead of changing the code. Then answer as before.';
}
