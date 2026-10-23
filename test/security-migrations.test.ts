import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { readDbApprovals, recoverDbApprovals } from '../src/database-routes.js';
import { readSshApprovals, recoverSshApprovals } from '../src/ssh-hosts.js';
import { SEALED_KEYS, Sealer } from '../src/secrets.js';
import { Store } from '../src/store.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dalang-security-'));
  const file = join(dir, 'state.db');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let store: Store | undefined;
  cleanups.push(() => store?.db.close());
  const open = () => {
    store?.db.close();
    store = new Store(file);
    store.sealKv(new Sealer('migration-test'), SEALED_KEYS);
    return store;
  };
  return { file, open };
}

describe('security migrations and restart recovery', () => {
  it('discards legacy push recipients with no identity and retains bound subscriptions across restarts', () => {
    const f = fixture();
    const old = new DatabaseSync(f.file);
    old.exec("CREATE TABLE push_subs(endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL); INSERT INTO push_subs VALUES ('legacy', '{}');");
    old.close();
    let store = f.open();
    expect(store.listPushSubs()).toEqual([]);
    store.addPushSub('bound', '{}', 'owner', 'session-hash');
    store = f.open();
    expect(store.listPushSubs()).toEqual([{ endpoint: 'bound', sub: '{}', user_key: 'owner', auth_hash: 'session-hash' }]);
  });

  it('restores historical and queued attachments to their projects without claiming unrelated files', () => {
    const f = fixture();
    let store = f.open();
    const project = store.createProject('private', 'project');
    const conv = store.createConversation(project.id);
    const turn = store.startTurn(conv.id, 'read');
    store.addEvent(turn, 'user.prompt', JSON.stringify({ prompt: 'read', attachments: ['historical-file'] }));
    store.enqueue(conv.id, 'read later', ['queued-file']);
    // Simulate the pre-migration database: neither attachment has an ownership record.
    store.db.prepare("DELETE FROM kv WHERE key='upload_acl_migrated'").run();
    store = f.open();
    expect(store.uploadProjects('historical-file')).toEqual([project.id]);
    expect(store.uploadProjects('queued-file')).toEqual([project.id]);
    expect(store.uploadProjects('unrelated-file')).toEqual([]);
    expect(store.uploadOwner('unrelated-file')).toBeNull();
    // Losing a project must not turn an attached file back into a pending uploader-owned file.
    store.db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
    store = f.open();
    expect(store.uploadProjects('historical-file')).toEqual([project.id]);
    expect(store.getProject(project.id)).toBeNull();
  });

  it('persists interrupted DB and SSH executions as unknown through multiple restarts', () => {
    const f = fixture();
    let store = f.open();
    for (const key of ['db_approvals', 'ssh_approvals']) {
      store.setKv(key, JSON.stringify([
        { id: 1, status: 'executing', at: 1, who: 'owner', conv: null },
        { id: 2, status: 'pending', at: 2, who: 'owner', conv: null },
        ...Array.from({ length: 205 }, (_, i) => ({ id: i + 3, status: 'approved', at: i + 3, who: 'owner', conv: null })),
      ]));
    }
    store = f.open();
    expect(readDbApprovals(store)[0]?.status).toBe('executing');
    expect(readSshApprovals(store)[0]?.status).toBe('executing');
    recoverDbApprovals(store);
    recoverSshApprovals(store);
    store = f.open();
    recoverDbApprovals(store);
    recoverSshApprovals(store);
    for (const list of [readDbApprovals(store), readSshApprovals(store)]) {
      expect(list).toHaveLength(202);
      expect(list[0]).toMatchObject({ id: 1, status: 'unknown', outcome: expect.stringMatching(/cannot run again/) });
      expect(list[1]).toMatchObject({ id: 2, status: 'pending' });
    }
  });
});
