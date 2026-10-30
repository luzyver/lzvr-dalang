import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
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
// An error nothing caught is written to crash.log (the autostart log is rewritten at every start). Once the server is up
// it keeps running: an exit would stop every turn, and nothing restarts it until the next logon. Before that (a port in
// use, a broken database) it exits 1 as Node would, so a service manager sees the failure.
const crashLog = join(cfg.stateDir, 'crash.log');
let started = false;
for (const kind of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(kind, (e: unknown) => {
    const text = `${new Date().toISOString()} ${kind}${started ? '' : ' (starting)'}: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`;
    console.error(text.trimEnd());
    try { appendFileSync(crashLog, text); } catch { /* the console line is all there is */ }
    if (!started) process.exit(1);
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
  autoTitle: cfg.autoTitle, autoMemory: cfg.autoMemory, contextCompactTokens: cfg.contextCompactTokens, skillsDir: SKILLS_DIR,
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

// A signed-out account is skipped like a switched-off one; check at start and every minute so prompts never hit it.
const watchLogins = () => Promise.all([logins, claudeLogins].map((l) => l.refreshAll().catch(() => {})));
await watchLogins(); // first check done before queues restart, so no turn is sent to an account that is already signed out
setInterval(() => void watchLogins(), 60_000).unref();

// A crash can leave turns `running`; fail them and restart any leftover queues.
for (const id of store.resetRunning()) dispatcher.kick(id);

const codeMemory = new CodeMemory(store, { cwd: cfg.stateDir });
const app = buildApp({ cfg, store, dispatcher, push, logins, claudeLogins, codeMemory });
await app.listen({ host: cfg.host, port: cfg.port });
codeMemory.start();
const scheduler = new Scheduler(store, dispatcher);
scheduler.start();
started = true;

// Stop without cutting chats off: the panel stays up while running turns get DRAIN_MINUTES to finish (new prompts wait
// in the queue); whatever still runs then is killed and resumed in its session after the restart. systemd sends SIGTERM
// on stop/restart (its unit needs KillMode=mixed, else the agents get the SIGTERM too); Windows has no such signal, so
// autostart.ps1 asks by creating state/restart. Ctrl+C (SIGINT) stops at once, resuming what ran.
let closing = false;
function close(drainMs: number): void {
  if (closing) return;
  closing = true;
  void (async () => {
    scheduler.stop();
    await dispatcher.shutdown(drainMs);
    await codeMemory.stop();
    await app.close().catch(() => {});
    process.exit(0);
  })();
  setTimeout(() => process.exit(1), drainMs + 15_000).unref();
}
process.on('SIGTERM', () => close(cfg.drainMs));
process.on('SIGINT', () => close(0));
const restartFlag = join(cfg.stateDir, 'restart');
rmSync(restartFlag, { force: true }); // one left from before this start is done
setInterval(() => {
  if (!existsSync(restartFlag)) return;
  rmSync(restartFlag, { force: true });
  close(cfg.drainMs);
}, 1000).unref();
if (cfg.authBypass) console.warn('AUTH_BYPASS is on: anyone reaching this port is the owner. Local development only.');
else if (!cfg.mailerUrl) console.warn('MAILER_URL is not set: email sign-in is off (the API token still works)');
else if (!cfg.ownerEmails.length) console.warn('LZVR_OWNER_EMAILS is empty: only panel users with an email can sign in by email');
console.log(`lzvr-dalang listening on ${cfg.host}:${cfg.port} with ${dispatcher.accounts.homes.length} account(s)`);
