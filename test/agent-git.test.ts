import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentGitEnv, agentGitGuide } from '../src/agent-git.js';
import { Dispatcher } from '../src/dispatcher.js';
import { Store } from '../src/store.js';
import { AUTH, turnsDone, until } from './helpers.js';
import { bearer, mkUser, setupApp } from './setup-app.js';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

/** A repository with one commit, a bare remote it can push to, and a change ready to commit. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'lzvr-agit-'));
  execFileSync('git', ['init', '-q', '--bare', join(dir, 'remote.git')]);
  const work = join(dir, 'work');
  execFileSync('git', ['init', '-q', work]);
  const git = (env: Record<string, string>, ...args: string[]) =>
    spawnSync('git', ['-C', work, ...ID, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
  git({}, 'commit', '-q', '--allow-empty', '-m', 'init');
  git({}, 'remote', 'add', 'origin', join(dir, 'remote.git'));
  writeFileSync(join(work, 'a.txt'), 'a\n');
  git({}, 'add', 'a.txt');
  return { git, work };
}

describe('agent git policy', () => {
  it('blocks what is not allowed through git config in the environment, after what is already there', () => {
    expect(agentGitEnv({ commit: true, push: true }, {})).toEqual({});
    const both = agentGitEnv({ commit: false, push: false }, { GIT_CONFIG_COUNT: '2' });
    expect(both.GIT_CONFIG_COUNT).toBe('4');
    expect(both.GIT_CONFIG_KEY_2).toBe('core.hooksPath');
    expect(both.GIT_CONFIG_VALUE_2).toMatch(/scripts\/agent-git-hooks$/);
    expect(both.GIT_CONFIG_KEY_3).toMatch(/^url\..+\.pushInsteadOf$/);
    expect(both.GIT_CONFIG_VALUE_3).toBe('');
    expect(agentGitEnv({ commit: true, push: false }, {})).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: '' });
  });

  it("makes the agent's git refuse to commit and push, while git without it (the panel's) still can", () => {
    const { git } = repo();
    const blocked = agentGitEnv({ commit: false, push: false }, process.env);
    const commit = git(blocked, 'commit', '-qm', 'agent');
    expect(commit.status).not.toBe(0);
    expect(commit.stderr).toContain('agents may not commit');
    expect(git(blocked, 'status', '--short').stdout).toContain('A  a.txt'); // still staged, nothing committed
    expect(git({}, 'commit', '-qm', 'person').status).toBe(0);
    const push = git(blocked, 'push', '-q', 'origin', 'HEAD');
    expect(push.status).not.toBe(0);
    expect(push.stderr).toContain('agents-may-not-push');
    expect(git(blocked, 'fetch', '-q', 'origin').status).toBe(0); // fetching is untouched
    expect(git({}, 'push', '-q', 'origin', 'HEAD').status).toBe(0);
    // Allowed: nothing in the way.
    const other = repo();
    expect(other.git(agentGitEnv({ commit: true, push: true }, process.env), 'commit', '-qm', 'agent').status).toBe(0);
  });

  it('tells the turn what it may not do, and nothing when it may do both', () => {
    expect(agentGitGuide({ commit: true, push: true })).toBe('');
    expect(agentGitGuide({ commit: false, push: false })).toContain('git commit and git push are blocked');
    expect(agentGitGuide({ commit: true, push: false })).toContain('do not push yourself');
    expect(agentGitGuide({ commit: true, push: false })).toContain('committed but unpushed');
  });

  it('applies to every turn by default, and is set by admins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lzvr-agit-'));
    const store = new Store();
    const fake = [process.execPath, fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))];
    const dispatcher = new Dispatcher(store, { homes: [], claudeHomes: [join(dir, 'a')], claudeCommand: fake });
    const conv = store.createConversation(store.createProject('p', dir).id, 'claude');
    const text = () => store.eventsAfter(conv.id, 0).map((e) => String(JSON.parse(e.payload).item?.text ?? '')).join('\n');
    store.enqueue(conv.id, 'one', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    expect(text()).toContain('|system:Git: do not commit or push yourself');
    expect(text()).toContain('|gitcfg:2');
    store.setAgentGit({ commit: true, push: true });
    store.enqueue(conv.id, 'two', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 2));
    expect(text().split('echo:two')[1]).not.toContain('gitcfg');

    const t = setupApp();
    const dev = await mkUser(t, 'budi', 'dev');
    expect((await t.app.inject({ url: '/api/settings/agent-git', headers: AUTH })).json()).toEqual({ commit: false, push: false });
    expect((await t.app.inject({ method: 'PUT', url: '/api/settings/agent-git', headers: bearer(dev.token), payload: { commit: true, push: true } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'PUT', url: '/api/settings/agent-git', headers: AUTH, payload: { commit: true, push: false } })).statusCode).toBe(204);
    expect(t.store.getAgentGit()).toEqual({ commit: true, push: false });
    await t.app.close();
  });
});
