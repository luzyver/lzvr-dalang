/**
 * Reaching a database through an SSH server (the SQL editor's "SSH tunnel"): for one run, an SSH connection and a port
 * on 127.0.0.1 whose connections it forwards to the database, as the SSH server sees it. Both close after the run.
 *
 * The SSH server is known by its host key: the one seen when the connection is tested is kept with it (trust on first
 * use, as `ssh` asks "are you sure you want to continue connecting?"), and a different key is refused afterwards.
 */
import { createHash } from 'node:crypto';
import { type AddressInfo, createServer, type Socket } from 'node:net';
import ssh2 from 'ssh2';

const { Client, utils } = ssh2;

export interface SshConf {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'key';
  password: string;
  /** An OpenSSH or PEM private key (the text of the file). */
  privateKey: string;
  passphrase: string;
  /** The SSH server's key, as OpenSSH prints it (SHA256:...), once trusted; empty before. */
  hostKey: string;
}

/** A key's fingerprint the way OpenSSH shows it: SHA256: and unpadded base64. */
export const fingerprint = (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/** Why this private key cannot be used, or null (a wrong passphrase, not a key, ...). */
export function keyProblem(privateKey: string, passphrase: string): string | null {
  const parsed = utils.parseKey(privateKey, passphrase || undefined);
  return parsed instanceof Error ? parsed.message : null;
}

export interface Tunnel {
  /** Where the database is reached now: 127.0.0.1 and a free port. */
  host: string;
  port: number;
  /** The SSH server's key fingerprint. */
  hostKey: string;
  close(): Promise<void>;
}

/**
 * Opens a tunnel to `target` (host and port as the SSH server sees them). `trustNew`: accept a server whose key was
 * not trusted yet (testing the connection), and report its key in `hostKey`.
 */
export async function openTunnel(ssh: SshConf, target: { host: string; port: number }, opts: { trustNew?: boolean; timeoutMs?: number } = {}): Promise<Tunnel> {
  const client = new Client();
  let seen = '';
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve()).once('error', reject);
      client.connect({
        host: ssh.host, port: ssh.port || 22, username: ssh.user,
        ...(ssh.auth === 'key' ? { privateKey: ssh.privateKey, passphrase: ssh.passphrase || undefined } : { password: ssh.password }),
        readyTimeout: opts.timeoutMs ?? 10_000, keepaliveInterval: 15_000,
        hostVerifier: (key: Buffer) => {
          seen = fingerprint(key);
          return ssh.hostKey ? seen === ssh.hostKey : !!opts.trustNew;
        },
      });
    });
  } catch (e) {
    client.end();
    if (seen && ssh.hostKey && seen !== ssh.hostKey) {
      throw new Error(`the SSH server's key changed: it is ${seen}, and ${ssh.hostKey} was trusted. If that is expected (the server was reinstalled), test the connection again and save it.`);
    }
    if (seen && !ssh.hostKey && !opts.trustNew) throw new Error(`the SSH server's key (${seen}) is not trusted yet: open Edit connection, Test connection, then Save`);
    throw new Error(`SSH ${ssh.host}: ${(e as Error).message}`);
  }
  // Each connection to the local port becomes a channel to the database through the SSH server.
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => sock.destroy());
    try {
      client.forwardOut('127.0.0.1', sock.remotePort ?? 0, target.host, target.port, (err, stream) => {
        if (err) { sock.destroy(); return; }
        stream.on('error', () => sock.destroy());
        stream.on('close', () => sock.destroy());
        sock.on('close', () => stream.end());
        sock.pipe(stream).pipe(sock);
      });
    } catch {
      sock.destroy(); // the SSH connection dropped ("Not connected" is thrown, not passed to the callback)
    }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  } catch (e) { client.end(); throw e; }
  return {
    host: '127.0.0.1', port: (server.address() as AddressInfo).port, hostKey: seen,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      client.end();
    },
  };
}
