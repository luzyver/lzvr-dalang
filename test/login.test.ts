import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Accounts } from '../src/accounts.js';
import { Logins } from '../src/login.js';
import { Store } from '../src/store.js';
import { FAKE, until } from './helpers.js';

function setup(env: Record<string, string> = {}, timeoutMs?: number, command = FAKE) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'lzvr-login-')));
  const primary = join(base, 'primary');
  mkdirSync(primary, { recursive: true });
  const accounts = new Accounts([primary]);
  const store = new Store();
  const logins = new Logins({ command, baseDir: join(base, 'accounts'), accounts, store, env, timeoutMs });
  return { base, primary, accounts, store, logins };
}
const settled = (l: Logins, id: string) => until(() => l.get(id)!.status !== 'pending');

describe('Logins.start', () => {
  it('shows the device link and code, then adds the account once Codex reports it logged in', async () => {
    const t = setup();
    const id = t.logins.start('second');
    await until(() => t.logins.get(id)!.url !== null);
    const mid = t.logins.get(id)!;
    expect(mid).toMatchObject({ name: 'second', url: 'https://auth.example.test/device', code: 'ABCD-1234' });
    expect(mid.output).not.toContain('\u001b'); // colour codes stripped
    await settled(t.logins, id);

    expect(t.logins.get(id)!.status).toBe('success');
    const home = join(t.base, 'accounts', 'second');
    expect(existsSync(join(home, 'auth.json'))).toBe(true);
    expect(t.accounts.homes).toEqual([t.primary, home]);
    expect(JSON.parse(t.store.getKv('extra_homes')!)).toEqual([home]);
    expect(t.logins.loadExtras()).toEqual([home]);
    // the new account shares the first account's sessions so a chat can move between them
    expect(lstatSync(join(home, 'sessions')).isSymbolicLink()).toBe(true);
    writeFileSync(join(t.primary, 'sessions', 'r.jsonl'), 'x');
    expect(existsSync(join(home, 'sessions', 'r.jsonl'))).toBe(true);
  });

  it('can add the very first account when none exists, and the next one shares its sessions', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'lzvr-first-')));
    const accounts = new Accounts([]);
    const store = new Store();
    const logins = new Logins({ command: FAKE, baseDir: join(base, 'accounts'), accounts, store });

    const a = logins.start('first');
    await settled(logins, a);
    expect(logins.get(a)!.status).toBe('success');
    const first = join(base, 'accounts', 'first');
    expect(accounts.homes).toEqual([first]);
    expect(accounts.primary()).toBe(first);
    expect(existsSync(join(first, 'sessions'))).toBe(true); // a real folder: it is the shared one

    const b = logins.start('second');
    await settled(logins, b);
    const second = join(base, 'accounts', 'second');
    expect(accounts.homes).toEqual([first, second]);
    expect(lstatSync(join(second, 'sessions')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(first, 'sessions')).isSymbolicLink()).toBe(false);
  });

  it('does not add an account when the login fails, and cleans up its folder', async () => {
    const t = setup({ FAKE_LOGIN: 'fail' });
    const id = t.logins.start('nope');
    await settled(t.logins, id);
    expect(t.logins.get(id)).toMatchObject({ status: 'failed' });
    expect(t.logins.get(id)!.error).toMatch(/device code expired/);
    expect(t.accounts.homes).toEqual([t.primary]);
    expect(t.store.getKv('extra_homes')).toBeNull();
    expect(existsSync(join(t.base, 'accounts', 'nope'))).toBe(false);
    expect(() => t.logins.start('nope')).not.toThrow(); // the name is free again
  });

  it('does not trust a clean exit alone: Codex must report the account as logged in', async () => {
    const t = setup({ FAKE_LOGIN: 'succeed-noauth' });
    const id = t.logins.start('ghost');
    await settled(t.logins, id);
    expect(t.logins.get(id)).toMatchObject({ status: 'failed' });
    expect(t.accounts.homes).toEqual([t.primary]);
  });

  it('can be cancelled while waiting for the user', async () => {
    const t = setup({ FAKE_LOGIN: 'hang' });
    const id = t.logins.start('later');
    await until(() => t.logins.get(id)!.url !== null);
    expect(t.logins.cancel(id)).toBe(true);
    expect(t.logins.get(id)!.status).toBe('cancelled');
    await until(() => !existsSync(join(t.base, 'accounts', 'later')));
    expect(t.accounts.homes).toEqual([t.primary]);
    expect(t.logins.cancel(id)).toBe(false);
    expect(() => t.logins.start('again')).not.toThrow(); // no longer busy
  });

  it('gives up after the timeout', async () => {
    const t = setup({ FAKE_LOGIN: 'hang' }, 250);
    const id = t.logins.start('slow');
    await settled(t.logins, id);
    expect(t.logins.get(id)).toMatchObject({ status: 'failed', error: 'timed out waiting for the login to be completed' });
  });

  it('allows one login at a time', async () => {
    const t = setup({ FAKE_LOGIN: 'hang' });
    t.logins.start('one');
    expect(() => t.logins.start('two')).toThrow(/already in progress/);
    try { t.logins.start('two'); } catch (e) { expect((e as { code: string }).code).toBe('busy'); }
  });

  it('rejects names that are unsafe or already taken', () => {
    const t = setup();
    for (const bad of ['', '../x', 'a b', 'A', '-x', 'x'.repeat(33), 'a/b', 'a\\b', '.hidden']) {
      expect(() => t.logins.start(bad), JSON.stringify(bad)).toThrow(/name must be/);
    }
    expect(() => t.logins.start('primary')).toThrow(/already exists/); // same name as the existing account
  });

  it('survives a missing codex binary', async () => {
    const t = setup({}, undefined, ['lzvr-no-such-binary']);
    const id = t.logins.start('x');
    await settled(t.logins, id);
    expect(t.logins.get(id)!.status).toBe('failed');
    expect(t.accounts.homes).toEqual([t.primary]);
  });

  it('returns null for an unknown login id', () => {
    expect(setup().logins.get('nope')).toBeNull();
    expect(setup().logins.cancel('nope')).toBe(false);
  });
});

describe('Logins.remove', () => {
  const add = async (t: ReturnType<typeof setup>, name: string) => { const id = t.logins.start(name); await settled(t.logins, id); };

  it('forgets a panel account and deletes its folder, leaving the shared sessions alone', async () => {
    const t = setup();
    await add(t, 'second');
    const home = join(t.base, 'accounts', 'second');
    writeFileSync(join(t.primary, 'sessions', 'r.jsonl'), 'x');
    t.logins.remove('second');
    expect(existsSync(home)).toBe(false);
    expect(t.accounts.homes).toEqual([t.primary]);
    expect(JSON.parse(t.store.getKv('extra_homes')!)).toEqual([]);
    expect(existsSync(join(t.primary, 'sessions', 'r.jsonl'))).toBe(true);
    await add(t, 'second'); // the name is free again
    expect(t.accounts.homes).toHaveLength(2);
  });

  it('only removes accounts added from the panel', () => {
    const t = setup();
    expect(() => t.logins.remove('primary')).toThrow(/no panel account/);
    expect(() => t.logins.remove('../x')).toThrow(/no panel account/);
    expect(t.accounts.homes).toEqual([t.primary]);
  });

  it('keeps the first account until the others are gone', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'lzvr-rm-')));
    const accounts = new Accounts([]);
    const logins = new Logins({ command: FAKE, baseDir: join(base, 'accounts'), accounts, store: new Store() });
    for (const n of ['one', 'two']) await settled(logins, logins.start(n));
    expect(() => logins.remove('one')).toThrow(/remove the other accounts first/);
    logins.remove('two');
    logins.remove('one');
    expect(accounts.homes).toEqual([]);
  });
});

describe('Logins.isLoggedIn', () => {
  it('asks Codex, and says unknown when it cannot', async () => {
    const t = setup();
    expect(await t.logins.isLoggedIn(t.primary)).toBe(false);
    writeFileSync(join(t.primary, 'auth.json'), '{}');
    expect(await t.logins.isLoggedIn(t.primary, { fresh: true })).toBe(true);
    const broken = setup({}, undefined, ['lzvr-no-such-binary']);
    expect(await broken.logins.isLoggedIn(broken.primary)).toBeNull();
  });

  it('caches the answer for a short while', async () => {
    const t = setup();
    expect(await t.logins.isLoggedIn(t.primary)).toBe(false);
    writeFileSync(join(t.primary, 'auth.json'), '{}');
    expect(await t.logins.isLoggedIn(t.primary)).toBe(false); // still the cached answer
    expect(await t.logins.isLoggedIn(t.primary, { fresh: true })).toBe(true);
  });
});
