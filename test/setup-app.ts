import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { Dispatcher } from '../src/dispatcher.js';
import type { GitAuth } from '../src/git-auth.js';
import { Logins } from '../src/login.js';
import { Push, type PushSend } from '../src/push.js';
import type { SendMail } from '../src/otp.js';
import { Store } from '../src/store.js';
import type { Terminals } from '../src/terminals.js';
import { FAKE, TOKEN } from './helpers.js';

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Create a panel user through the API (as the owner) and return their id and one-time token. */
export async function mkUser(t: { app: { inject: (o: any) => Promise<any> } }, name: string, role: 'admin' | 'dev') {
  const r = await t.app.inject({ method: 'POST', url: '/api/users', headers: { authorization: `Bearer ${TOKEN}` }, payload: { name, role } });
  if (r.statusCode !== 201) throw new Error(`mkUser failed: ${r.statusCode} ${r.body}`);
  return r.json() as { id: string; name: string; role: string; token: string };
}

export interface AppExtras {
  clickupFetch?: typeof fetch;
  maxUploadBytes?: number;
  authMaxFailures?: number;
  pushSend?: PushSend;
  sendMail?: SendMail;
  gitAuth?: GitAuth;
  gitSshCommand?: string[];
  terminals?: Terminals;
  cfg?: Partial<Config>;
  /** Codex homes the app starts with (default: one). Pass [] to test the "no account yet" state. */
  homes?: string[];
  /** Environment for the fake `codex login` (FAKE_LOGIN=...). */
  loginEnv?: Record<string, string>;
}

export function setupApp(env: Record<string, string> = {}, extra: AppExtras = {}) {
  const base = mkdtempSync(join(tmpdir(), 'lzvr-app-'));
  const root = join(base, 'ws');
  mkdirSync(join(root, 'proj'), { recursive: true });
  const cfg: Config = {
    token: TOKEN, workspaceRoot: root, limitBlockMs: 3_600_000,
    stateDir: join(base, 'state'), port: 0, host: '127.0.0.1', trustProxy: [], codexCommand: FAKE, claudeCommand: FAKE,
    origin: 'http://localhost:9876', mcpCrossSend: 'approve', ownerEmails: [], authBypass: false,
    ...extra.cfg,
  };
  const store = new Store();
  const dispatcher = new Dispatcher(store, { homes: extra.homes ?? [join(base, 'home')], command: FAKE, env });
  const push = new Push(store, { send: extra.pushSend ?? (async () => {}) });
  const logins = new Logins({
    command: FAKE, baseDir: join(cfg.stateDir, 'accounts'), accounts: dispatcher.accounts, store, env: extra.loginEnv,
  });
  const { cfg: _cfg, pushSend: _p, loginEnv: _l, homes: _h, ...appExtras } = extra;
  const app = buildApp({ cfg, store, dispatcher, push, logins, ...appExtras });
  return { app, store, dispatcher, push, logins, cfg, root, base };
}
