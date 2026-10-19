import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSecretKey, SEALED_KEYS, Sealer } from '../src/secrets.js';
import { Store } from '../src/store.js';
import { AUTH } from './helpers.js';
import { setupApp } from './setup-app.js';

const raw = (store: Store, key: string) => (store.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined)?.value;

describe('secrets at rest', () => {
  it('seals and opens, and refuses another key', () => {
    const s = new Sealer('one');
    const sealed = s.seal('hunter2');
    expect(sealed).toMatch(/^enc1:/);
    expect(sealed).not.toContain('hunter2');
    expect(s.seal('hunter2')).not.toBe(sealed);
    expect(s.open(sealed)).toBe('hunter2');
    expect(s.open('plain')).toBe('plain');
    expect(() => new Sealer('two').open(sealed)).toThrow(/not the key it was saved with/);
  });

  it('encrypts what was stored in clear, keeps other entries as they are, and refuses a wrong key before changing anything', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lzvr-sec-')), 'lzvr.db');
    const before = new Store(file);
    before.setKv('db_connections', '[{"password":"hunter2"}]');
    before.setKv('subagents', '{"mode":"auto"}');
    before.db.close();

    const store = new Store(file);
    expect(store.sealKv(new Sealer('k'), SEALED_KEYS)).toEqual({ migrated: ['db_connections'] });
    expect(raw(store, 'db_connections')).toMatch(/^enc1:/);
    expect(store.getKv('db_connections')).toBe('[{"password":"hunter2"}]');
    expect(raw(store, 'subagents')).toBe('{"mode":"auto"}');
    store.setKv('ssh_hosts', '[{"password":"x9"}]');
    expect(raw(store, 'ssh_hosts')).toMatch(/^enc1:/);
    store.db.close();
    // Compacted: the old text is gone from the file.
    expect(readFileSync(file).includes('hunter2')).toBe(false);

    const wrong = new Store(file);
    expect(() => wrong.sealKv(new Sealer('other'), SEALED_KEYS)).toThrow(/LZVR_SECRET_KEY/);
    expect(raw(wrong, 'ssh_hosts')).toMatch(/^enc1:/);
    wrong.db.close();
  });

  it('takes the key from LZVR_SECRET_KEY, else from a file it makes once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lzvr-key-'));
    expect(loadSecretKey({ LZVR_SECRET_KEY: ' abc ' }, dir)).toEqual({ secret: 'abc', fromFile: null });
    expect(existsSync(join(dir, 'secret.key'))).toBe(false);
    const a = loadSecretKey({}, dir);
    expect(a.fromFile).toBe(join(dir, 'secret.key'));
    expect(a.secret.length).toBeGreaterThan(30);
    expect(loadSecretKey({}, dir).secret).toBe(a.secret);
  });

  it('keeps an SSH host\'s password out of the database file', async () => {
    const t = setupApp();
    const r = await t.app.inject({ method: 'PUT', url: '/api/ssh/hosts/vm', headers: AUTH, payload: {
      label: 'vm', host: '10.0.0.1', user: 'u', auth: 'password', password: 'hunter2-secret', access: 'all', agent: 'run' } });
    expect(r.statusCode).toBe(200);
    expect(raw(t.store, 'ssh_hosts')).toMatch(/^enc1:/);
    expect(raw(t.store, 'ssh_hosts')).not.toContain('10.0.0.1');
    await t.app.close();
  });
});
