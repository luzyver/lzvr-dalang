import { describe, expect, it } from 'vitest';
import { describeTurn, Push } from '../src/push.js';
import { Store } from '../src/store.js';
import { Dispatcher } from '../src/dispatcher.js';
import { AUTH, FAKE, turnsDone, until } from './helpers.js';
import { bearer, mkUser, setupApp } from './setup-app.js';

const SUB = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'p', auth: 'a' } });

describe('push routes', () => {
  it('serves a stable VAPID public key and stores/removes subscriptions', async () => {
    const t = setupApp();
    const k1 = (await t.app.inject({ url: '/api/push/key', headers: AUTH })).json().publicKey;
    const k2 = (await t.app.inject({ url: '/api/push/key', headers: AUTH })).json().publicKey;
    expect(k1).toMatch(/^[\w-]{80,}$/);
    expect(k2).toBe(k1);

    const sub = (n: number) => t.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: AUTH, payload: { subscription: SUB(n) } });
    expect((await sub(1)).statusCode).toBe(204);
    expect((await sub(1)).statusCode).toBe(204); // same endpoint again replaces, not duplicates
    expect((await sub(2)).statusCode).toBe(204);
    expect(t.store.listPushSubs()).toHaveLength(2);

    const un = await t.app.inject({ method: 'POST', url: '/api/push/unsubscribe', headers: AUTH, payload: { endpoint: SUB(1).endpoint } });
    expect(un.statusCode).toBe(204);
    expect(t.store.listPushSubs().map((s) => s.endpoint)).toEqual([SUB(2).endpoint]);
  });

  it('validates the subscription and requires auth', async () => {
    const t = setupApp();
    const bad = await t.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: AUTH, payload: { subscription: { endpoint: 'x' } } });
    expect(bad.statusCode).toBe(400);
    expect((await t.app.inject({ url: '/api/push/key' })).statusCode).toBe(401);
  });
});

describe('Push.notify', () => {
  it('sends to authorized subscriptions and drops the ones the push service says are gone', async () => {
    const store = new Store();
    const sent: { endpoint: string; payload: string }[] = [];
    const push = new Push(store, {
      send: async (sub, payload) => {
        if (sub.endpoint.endsWith('/2')) throw Object.assign(new Error('gone'), { statusCode: 410 });
        if (sub.endpoint.endsWith('/3')) throw Object.assign(new Error('flaky'), { statusCode: 500 });
        sent.push({ endpoint: sub.endpoint, payload });
      },
    });
    const conv = store.createConversation(store.createProject('p', process.cwd()).id);
    for (const n of [1, 2, 3]) store.addPushSub(SUB(n).endpoint, JSON.stringify(SUB(n)), 'owner', 'test');

    await push.notify({ title: 'Done', body: 'p: finished', convId: conv.id });

    expect(sent.map((s) => s.endpoint)).toEqual([SUB(1).endpoint]);
    expect(JSON.parse(sent[0]!.payload)).toEqual({ title: 'Done', body: 'p: finished', convId: conv.id });
    expect(store.listPushSubs().map((s) => s.endpoint).sort()).toEqual([SUB(1).endpoint, SUB(3).endpoint]);
  });

  it('checks current project, connection and host access for the subscribing user', async () => {
    const sent: string[] = [];
    const t = setupApp({}, { pushSend: async (sub) => { sent.push(sub.endpoint); } });
    const dev = await mkUser(t, 'dev', 'dev');
    const admin = await mkUser(t, 'admin', 'admin');
    for (const [n, headers] of [[1, AUTH], [2, bearer(admin.token)], [3, bearer(dev.token)]] as const) {
      await t.app.inject({ method: 'POST', url: '/api/push/subscribe', headers, payload: { subscription: SUB(n) } });
    }
    const project = t.store.createProject('secret', t.root, 'workspace-write', 'codex', 'owner');
    const conv = t.store.createConversation(project.id);
    await t.push.notify({ title: 'Secret', body: 'private text', convId: conv.id });
    expect(sent.splice(0)).toEqual([SUB(1).endpoint]);
    t.store.db.prepare("UPDATE projects SET access='all' WHERE id=?").run(project.id);
    await t.push.notify({ title: 'Shared', body: 'text', convId: conv.id });
    expect(sent.splice(0).sort()).toEqual([1, 2, 3].map((n) => SUB(n).endpoint));
    t.store.setKv('db_connections', JSON.stringify([{ id: 'db', access: 'owner' }]));
    await t.push.notify({ title: 'SQL', body: 'secret SQL', convId: conv.id, audience: { admin: true, database: 'db' } });
    expect(sent.splice(0)).toEqual([SUB(1).endpoint]);
    t.store.setKv('ssh_hosts', JSON.stringify([{ id: 'host', access: 'admin' }]));
    await t.push.notify({ title: 'SSH', body: 'command', convId: conv.id, audience: { admin: true, host: 'host' } });
    expect(sent.splice(0).sort()).toEqual([1, 2].map((n) => SUB(n).endpoint));
    t.store.setUserRole(admin.id, 'dev');
    await t.push.notify({ title: 'SSH', body: 'command', convId: conv.id, audience: { admin: true, host: 'host' } });
    expect(sent.splice(0)).toEqual([SUB(1).endpoint]);
    t.store.deleteUser(dev.id);
    await t.push.notify({ title: 'Shared', body: 'text', convId: conv.id });
    expect(sent.splice(0).sort()).toEqual([1, 2].map((n) => SUB(n).endpoint));
    // An authenticated user cannot remove another user's device subscription.
    await t.app.inject({ method: 'POST', url: '/api/push/unsubscribe', headers: bearer(admin.token), payload: { endpoint: SUB(1).endpoint } });
    expect(t.store.listPushSubs().some((s) => s.endpoint === SUB(1).endpoint)).toBe(true);
    await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: bearer(admin.token) });
    expect(t.store.listPushSubs().map((s) => s.endpoint)).toEqual([SUB(1).endpoint]);
    await t.app.close();
  });

  it('does nothing without subscriptions', async () => {
    const push = new Push(new Store(), { send: async () => { throw new Error('should not send'); } });
    await push.notify({ title: 't', body: 'b', convId: 'c' });
  });
});

describe('describeTurn', () => {
  it('maps turn outcomes to notifications', () => {
    const e = (status: string, lastMessage = '') => describeTurn({ convId: 'c', project: 'proj', status, lastMessage });
    expect(e('completed', 'All done.')).toMatchObject({ title: 'Finished', body: expect.stringContaining('proj') });
    expect(e('completed', 'Which database should I use?')).toMatchObject({ title: 'Needs your input' });
    expect(e('failed')).toMatchObject({ title: 'Failed' });
    expect(e('cancelled')).toBeNull();
  });
});

describe('Dispatcher onTurnEnd', () => {
  it('reports the outcome, last message and project name of each turn', async () => {
    const store = new Store();
    const seen: any[] = [];
    const dispatcher = new Dispatcher(store, { homes: ['/tmp/h'], command: FAKE, onTurnEnd: (e) => seen.push(e) });
    const project = store.createProject('myproj', process.cwd());
    const conv = store.createConversation(project.id);
    store.enqueue(conv.id, 'what now?', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1) && seen.length === 1);
    expect(seen[0]).toMatchObject({ convId: conv.id, project: 'myproj', status: 'completed', lastMessage: 'what now?' });
  });
});
