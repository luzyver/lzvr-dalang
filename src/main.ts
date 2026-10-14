import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_SHARED_DIRS, linkSessions, migrateCodexAccounts } from './accounts.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Dispatcher } from './dispatcher.js';
import { Logins } from './login.js';
import { Push } from './push.js';
import { Store } from './store.js';

const cfg = loadConfig();
mkdirSync(cfg.stateDir, { recursive: true });
const store = new Store(join(cfg.stateDir, 'lzvr.db'));
const push = new Push(store, { subject: cfg.vapidSubject ?? (cfg.origin ? cfg.origin : undefined) });
const dispatcher = new Dispatcher(store, {
  homes: [], // no account exists until an admin adds one in the panel; they are loaded from the database just below
  command: cfg.codexCommand, claudeCommand: cfg.claudeCommand, blockMs: cfg.limitBlockMs, limitRe: cfg.limitRegex, mcpUrl: cfg.mcpUrl,
  autoTitle: cfg.autoTitle,
  onTurnEnd: (e) => push.notifyTurn(e),
});

migrateCodexAccounts(cfg.stateDir, { get: (k) => store.getKv(k), set: (k, v) => store.setKv(k, v) });

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

const app = buildApp({ cfg, store, dispatcher, push, logins, claudeLogins });
await app.listen({ host: cfg.host, port: cfg.port });

// systemd sends SIGTERM on stop/restart: kill running turns cleanly.
let closing = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    void (async () => {
      await dispatcher.shutdown();
      await app.close().catch(() => {});
      process.exit(0);
    })();
    setTimeout(() => process.exit(1), 15_000).unref();
  });
}
console.log(`lzvr-dalang listening on ${cfg.host}:${cfg.port} with ${dispatcher.accounts.homes.length} account(s)`);
