/**
 * Whether chat agents may commit and push themselves. By default they may not: the person commits and pushes from the
 * panel (the chat's Changes tab), which Dalang runs with its own git, outside any turn, so it is never blocked.
 *
 * A turn that may not gets git config through its environment (GIT_CONFIG_COUNT/KEY_n/VALUE_n), which every git it runs
 * reads, whatever the shell or backend:
 * - commit: `core.hooksPath` points at scripts/agent-git-hooks, whose pre-commit and pre-merge-commit refuse. That also
 *   leaves the repository's own hooks out of the agent's git, and `--no-verify` skips hooks: it stops habit, not an agent
 *   set on getting round it, so the turn is also told not to.
 * - push: every push URL is rewritten (`url.<blocked>.pushInsteadOf` = "") to a path that cannot exist and says why, so
 *   `git push` fails at once, `--no-verify` or not. Fetching is untouched.
 */
import { fileURLToPath } from 'node:url';

export interface AgentGitPolicy { commit: boolean; push: boolean }
export const AGENT_GIT_DEFAULTS: AgentGitPolicy = { commit: false, push: false };

const HOOKS = fileURLToPath(new URL('../scripts/agent-git-hooks', import.meta.url)).replace(/\\/g, '/');
const BLOCKED_PUSH = '/dev/null/agents-may-not-push--the-person-pushes-from-the-Dalang-panel/';

/** The environment that blocks what `p` does not allow, after the GIT_CONFIG_* entries `inherited` already has. */
export function agentGitEnv(p: AgentGitPolicy, inherited: Record<string, string | undefined>): Record<string, string> {
  const entries: [string, string][] = [];
  if (!p.commit) entries.push(['core.hooksPath', HOOKS]);
  if (!p.push) entries.push([`url.${BLOCKED_PUSH}.pushInsteadOf`, '']);
  if (!entries.length) return {};
  const base = Number(inherited.GIT_CONFIG_COUNT) || 0;
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(base + entries.length) };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${base + i}`] = key;
    env[`GIT_CONFIG_VALUE_${base + i}`] = value;
  });
  return env;
}

/** The panel's instructions for a commit message and for a Merge Request description. */
export interface GitWriting { commit: string; mr: string }

/**
 * Claude Code signs its commits (Co-Authored-By) and Merge Requests ("Generated with") unless its settings say what to
 * add instead: nothing. For turns that may commit or push; goes with the turn's other `--settings` (mergeHookArgs).
 */
export const NO_ATTRIBUTION_ARGS = ['--settings', JSON.stringify({ attribution: { commit: '', pr: '' } })];

/**
 * What a turn is told about git: what it may not do, and for what it may do, how the panel wants it written (the same
 * instructions "Generate message" and "Generate MR description" follow) and that nothing signs it as the agent's.
 */
export function agentGitGuide(p: AgentGitPolicy, writing?: GitWriting): string {
  const parts: string[] = [];
  if (!p.commit || !p.push) {
    const what = !p.commit && !p.push ? 'commit or push' : !p.commit ? 'commit' : 'push';
    const blocked = !p.commit && !p.push ? 'git commit and git push are' : `git ${what} is`;
    parts.push(`Git: do not ${what} yourself, even when asked to: in Dalang the person does that from the panel (the chat's
Changes tab), and ${blocked} blocked for you. Leave your changes ${p.commit ? 'committed but unpushed' : 'uncommitted'} and
say they are ready. Other git commands (status, diff, log, show, branch, stash) are fine.`);
  }
  if (p.commit || p.push) {
    parts.push(`Git attribution: commits, Merge Requests and Pull Requests you make carry no line naming an agent or a tool: no
Co-Authored-By trailer, no "Generated with" line, whatever else you were told to add. This comes from the person's
settings in Dalang.`);
  }
  // Written for a request that answers with the text alone, so the turn is told to keep the rules and not the reply format.
  if (p.commit && writing?.commit.trim()) {
    parts.push(`Commit messages: write every commit message by the instructions below.
They were written for a request that answers with the message alone: follow what they say about the message, and
ignore what they say about how to reply.
<commit_message_instructions>
${writing.commit.trim()}
</commit_message_instructions>`);
  }
  if (p.push && writing?.mr.trim()) {
    parts.push(`Merge Request and Pull Request descriptions: when you open one, or are asked to write its description, follow the
instructions below. When they ask for a Title section, its line (without
backticks) is the request's title and the other sections are its description.
<merge_request_instructions>
${writing.mr.trim()}
</merge_request_instructions>`);
  }
  return parts.join('\n\n');
}
