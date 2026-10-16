import { type AddressInfo, connect, createServer, type Server as NetServer } from 'node:net';
import { Server, utils } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { fingerprint, openTunnel, type SshConf } from '../src/ssh-tunnel.js';
import { AUTH } from './helpers.js';
import { setupApp } from './setup-app.js';

const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

const hostKeys = utils.generateKeyPairSync('ed25519');
const userKeys = utils.generateKeyPairSync('ed25519', { passphrase: 'pp', cipher: 'aes256-cbc', rounds: 16 });
const allowedUserKey = utils.parseKey(userKeys.public) as ReturnType<typeof utils.parseKey> & { getPublicSSH(): Buffer; verify(d: Buffer, s: Buffer, h?: string): boolean };
const serverFingerprint = fingerprint((utils.parseKey(hostKeys.public) as unknown as { getPublicSSH(): Buffer }).getPublicSSH());

/** An SSH server (user u, password p or the user key) forwarding to anything, and a TCP echo server to reach through it. */
async function servers(): Promise<{ sshPort: number; echoPort: number }> {
  const echo: NetServer = createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  const ssh = new Server({ hostKeys: [hostKeys.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.username !== 'u') return ctx.reject();
      if (ctx.method === 'password' && ctx.password === 'p') return ctx.accept();
      if (ctx.method === 'publickey' && ctx.key.data.equals(allowedUserKey.getPublicSSH())) {
        if (!ctx.signature) return ctx.accept();
        return allowedUserKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject();
      }
      return ctx.reject();
    }).on('ready', () => {
      client.on('tcpip', (accept, _reject, info) => {
        const channel = accept();
        const sock = connect(info.destPort, info.destIP);
        channel.pipe(sock).pipe(channel);
        sock.on('error', () => channel.close());
      });
    }).on('error', () => {});
  });
  await new Promise<void>((r) => ssh.listen(0, '127.0.0.1', () => r()));
  closers.push(() => new Promise((r) => echo.close(r)), () => new Promise((r) => ssh.close(r)));
  return { sshPort: (ssh.address() as AddressInfo).port, echoPort: (echo.address() as AddressInfo).port };
}

/** Sends `text` through the tunnel and reads what comes back. */
function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => s.write(text));
    s.on('data', (d) => { resolve(String(d)); s.end(); });
    s.on('error', reject);
  });
}

const conf = (sshPort: number, extra: Partial<SshConf> = {}): SshConf => ({
  enabled: true, host: '127.0.0.1', port: sshPort, user: 'u', auth: 'password', password: 'p', privateKey: '', passphrase: '', hostKey: '', ...extra,
});

describe('SSH tunnel', () => {
  it('forwards a local port to the target through the SSH server, with a password or a key', async () => {
    const { sshPort, echoPort } = await servers();
    for (const extra of [{}, { auth: 'key' as const, password: '', privateKey: userKeys.private, passphrase: 'pp' }]) {
      const t = await openTunnel(conf(sshPort, { ...extra, hostKey: serverFingerprint }), { host: '127.0.0.1', port: echoPort });
      expect(await roundTrip(t.port, 'ping')).toBe('ping');
      await t.close();
    }
  });

  it('trusts a server\'s key only when testing, and refuses a key that changed', async () => {
    const { sshPort, echoPort } = await servers();
    const target = { host: '127.0.0.1', port: echoPort };
    await expect(openTunnel(conf(sshPort), target)).rejects.toThrow(/not trusted yet/);
    const t = await openTunnel(conf(sshPort), target, { trustNew: true });
    expect(t.hostKey).toBe(serverFingerprint);
    await t.close();
    await expect(openTunnel(conf(sshPort, { hostKey: 'SHA256:somethingElse' }), target)).rejects.toThrow(/key changed/);
  });

  it('reports a wrong password', async () => {
    const { sshPort, echoPort } = await servers();
    await expect(openTunnel(conf(sshPort, { password: 'nope', hostKey: serverFingerprint }), { host: '127.0.0.1', port: echoPort })).rejects.toThrow(/^SSH 127\.0\.0\.1: /);
  });
});

describe('SSH settings of a connection', () => {
  it('keeps the SSH secrets on the server and refuses a key it cannot read', async () => {
    const t = setupApp();
    const put = (ssh: object) => t.app.inject({ method: 'PUT', url: '/api/db/connections/pg', headers: AUTH, payload: {
      label: 'PG', driver: 'postgres', host: 'db.internal', access: 'all', readOnly: false, agent: 'off', ssh } });
    const r = await put({ enabled: true, host: 'bastion', user: 'deploy', auth: 'key', privateKey: userKeys.private, passphrase: 'pp', hostKey: 'SHA256:abc' });
    expect(r.statusCode).toBe(200);
    expect(r.json().ssh).toEqual({ enabled: true, host: 'bastion', port: 22, user: 'deploy', auth: 'key', hostKey: 'SHA256:abc', hasPassword: false, hasKey: true, hasPassphrase: true });
    const list = (await t.app.inject({ url: '/api/db/connections', headers: AUTH })).body;
    expect(list).not.toContain('PRIVATE KEY');
    expect(list).not.toContain('"pp"');
    // Saving again without the secrets keeps them; another SSH host forgets the trusted key.
    expect((await put({ enabled: true, host: 'bastion', user: 'deploy', auth: 'key' })).json().ssh).toMatchObject({ hasKey: true, hostKey: 'SHA256:abc' });
    expect((await put({ enabled: true, host: 'other', user: 'deploy', auth: 'key' })).json().ssh).toMatchObject({ hasKey: true, hostKey: '' });
    expect((await put({ enabled: true, host: 'bastion', user: 'deploy', auth: 'key', privateKey: 'not a key' })).json().error).toMatch(/cannot be read/);
    expect((await put({ enabled: true, host: 'bastion', user: 'deploy', auth: 'key', privateKey: userKeys.private, passphrase: 'wrong' })).json().error).toMatch(/cannot be read/);
  });
});
