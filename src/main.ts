import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_SHARED_DIRS, linkSessions } from './accounts.js';
import { buildApp } from './app.js';
import { CodeMemory } from './code-memory.js';
import { loadConfig } from './config.js';
import { Dispatcher } from './dispatcher.js';
import { Logins } from './login.js';
import { Push } from './push.js';
import { Scheduler } from './schedules.js';
import { loadSecretKey, SEALED_KEYS, Sealer } from './secrets.js';
import { SKILLS_DIR } from './skills.js';
import { Store } from './store.js';

const cfg = loadConfig();
mkdirSync(cfg.stateDir, { recursive: true });
// An error nothing caught is written to crash.log (the autostart log is rewritten at every start) and the server keeps
// running: an exit would stop every turn, and nothing restarts it until the next logon.
const crashLog = join(cfg.stateDir, 'crash.log');
for (const kind of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(kind, (e: unknown) => {
    const text = `${new Date().toISOString()} ${kind}: ${e instanceof Error ? e.stack ?? e.message : String(e)}
`;
    console.error(text.trimEnd());
    try { appendFileSync(crashLog, text); } catch { /* the console line is all there is */ }
  });
}
const store = new Store(join(cfg.stateDir, 'lzvr.db'));
// Passwords, keys and tokens in the database are stored encrypted (secrets.ts), before anything reads them.
{
  const key = loadSecretKey(process.env, cfg.stateDir);
  const { migrated } = store.sealKv(new Sealer(key.secret), SEALED_KEYS);
  if (migrated.length) console.log(`encrypted the secrets stored in clear: ${migrated.join(', ')}`);
  if (key.fromFile) {
    console.warn(`secrets are encrypted with ${key.fromFile}; set LZVR_SECRET_KEY to its content (and delete the file) so agents `
      + 'that can read the state folder cannot read it');
  }
}
const push = new Push(store, { subject: cfg.vapidSubject ?? (cfg.origin ? cfg.origin : undefined) });
const dispatcher = new Dispatcher(store, {
  homes: [], // no account exists until an admin adds one in the panel; they are loaded from the database just below
  command: cfg.codexCommand, claudeCommand: cfg.claudeCommand, blockMs: cfg.limitBlockMs, limitRe: cfg.limitRegex, mcpUrl: cfg.mcpUrl,
  autoTitle: cfg.autoTitle, autoMemory: cfg.autoMemory, skillsDir: SKILLS_DIR,
  onTurnEnd: (e) => push.notifyTurn(e),
});

// Accounts added from the panel in earlier runs come after the configured ones.
const logins = new Logins({
  command: cfg.codexCommand, baseDir: join(cfg.stateDir, 'codex-accounts'), accounts: dispatcher.accounts, store,
});
const claudeLogins = new Logins({
  backend: 'claude', command: cfg.claudeCommand, baseDir: join(cfg.stateDir, 'claude-accounts'), accounts: dispatcher.claudeAccounts, store,
});
for (const h of claudeLogins.loadExtras()) dispatcher.claudeAccounts.add(h);
linkSessions(dispatcher.claudeAccounts.homes, CLAUDE_SHARED_DIRS);
for (const h of logins.loadExtras()) dispatcher.accounts.add(h);
for (const h of linkSessions(dispatcher.accounts.homes)) {
  console.warn(`${h}/sessions already exists and was not linked; sessions will not resume across accounts for it`);
}

dispatcher.loadDisabled();

// A crash can leave turns `running`; fail them and restart any leftover queues.
for (const id of store.resetRunning()) dispatcher.kick(id);

const codeMemory = new CodeMemory(store, { cwd: cfg.stateDir });
const app = buildApp({ cfg, store, dispatcher, push, logins, claudeLogins, codeMemory });
await app.listen({ host: cfg.host, port: cfg.port });
codeMemory.start();
const scheduler = new Scheduler(store, dispatcher);
scheduler.start();

// systemd sends SIGTERM on stop/restart: kill running turns cleanly.
let closing = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    void (async () => {
      scheduler.stop();
      await dispatcher.shutdown();
      await codeMemory.stop();
      await app.close().catch(() => {});
      process.exit(0);
    })();
    setTimeout(() => process.exit(1), 15_000).unref();
  });
}
if (cfg.authBypass) console.warn('AUTH_BYPASS is on: anyone reaching this port is the owner. Local development only.');
else if (!cfg.mailerUrl) console.warn('MAILER_URL is not set: email sign-in is off (the API token still works)');
else if (!cfg.ownerEmails.length) console.warn('LZVR_OWNER_EMAILS is empty: only panel users with an email can sign in by email');
console.log(`lzvr-dalang listening on ${cfg.host}:${cfg.port} with ${dispatcher.accounts.homes.length} account(s)`);
