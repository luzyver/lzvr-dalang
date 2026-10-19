/**
 * Secrets at rest: the database values that hold passwords, keys and tokens (SSH hosts, SQL editor connections,
 * ClickUp, other MCP servers, the push key) are stored encrypted with AES-256-GCM, so the database file alone (a copy,
 * a backup, an agent reading `lzvr.db`) does not give them away.
 *
 * The key comes from LZVR_SECRET_KEY, which Dalang never passes on to the agents, terminals or git it starts (no
 * LZVR_* variable reaches them). Without it, a key file is made in the state folder: that keeps the secrets out of the
 * database file, but not from whoever can read the folder. Either way this is not a wall against an agent running as
 * the same OS user, which can read Dalang's own environment or service file; only another OS user is.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PREFIX = 'enc1:';

/** The KV entries that hold secrets. */
export const SEALED_KEYS = ['ssh_hosts', 'db_connections', 'clickup', 'mcp_servers', 'vapid'];

export class Sealer {
  private key: Buffer;
  /** `secret`: any text; the AES key is its SHA-256. */
  constructor(secret: string) {
    if (!secret) throw new Error('an empty secret key');
    this.key = createHash('sha256').update(secret).digest();
  }

  static isSealed = (value: string) => value.startsWith(PREFIX);

  seal(text: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return `${PREFIX}${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${body.toString('base64')}`;
  }

  /** The text `value` was sealed from; a value stored before encryption came is returned as it is. Throws on another key. */
  open(value: string): string {
    if (!Sealer.isSealed(value)) return value;
    const [iv, tag, body] = value.slice(PREFIX.length).split(':');
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv ?? '', 'base64'));
      d.setAuthTag(Buffer.from(tag ?? '', 'base64'));
      return Buffer.concat([d.update(Buffer.from(body ?? '', 'base64')), d.final()]).toString('utf8');
    } catch {
      throw new Error('a stored secret cannot be decrypted: LZVR_SECRET_KEY is not the key it was saved with');
    }
  }
}

/** The key: LZVR_SECRET_KEY, else `<stateDir>/secret.key` (made the first time, readable by its owner only). */
export function loadSecretKey(env: NodeJS.ProcessEnv, stateDir: string): { secret: string; fromFile: string | null } {
  const fromEnv = env.LZVR_SECRET_KEY?.trim();
  if (fromEnv) return { secret: fromEnv, fromFile: null };
  const file = join(stateDir, 'secret.key');
  if (!existsSync(file)) {
    writeFileSync(file, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* Windows */ }
  }
  return { secret: readFileSync(file, 'utf8').trim(), fromFile: file };
}
