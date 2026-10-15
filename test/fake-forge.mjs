// Fake `gh` / `glab` for Settings → Git: `fake-forge.mjs <dir> <args...>`. Keeps its logins in logins.json in its config
// folder (GH_CONFIG_DIR / GLAB_CONFIG_DIR, like the real ones; else <dir>) and appends every call (arguments, stdin,
// GH_HOST/GITLAB_HOST, config folder) to <dir>/calls.log as a JSON line.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...args] = process.argv.slice(2);
const configDir = process.env.GH_CONFIG_DIR || process.env.GLAB_CONFIG_DIR || dir;
const file = join(configDir, 'logins.json');
const logins = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const save = () => writeFileSync(file, JSON.stringify(logins));
const flag = (name) => args[args.indexOf(name) + 1];
let input = '';
if (!process.stdin.isTTY) { try { input = readFileSync(0, 'utf8'); } catch { /* no stdin */ } }
appendFileSync(join(dir, 'calls.log'), `${JSON.stringify({
  args, input, host: process.env.GH_HOST ?? process.env.GITLAB_HOST ?? null, leaked: process.env.LZVR_TOKEN ?? null,
  configDir: configDir === dir ? null : configDir,
})}\n`);

const cmd = args.slice(0, 2).join(' ');
if (cmd === 'auth status') {
  const hosts = Object.entries(logins);
  if (!hosts.length) { console.error('You are not logged into any GitHub hosts.'); process.exit(1); }
  for (const [host, user] of hosts) console.log(`${host}\n  ✓ Logged in to ${host} account ${user} (keyring)\n  - Active account: true`);
} else if (cmd === 'auth login' && args.includes('--web')) {
  console.error('! One-time code (AB12-CD34) copied to clipboard');
  console.error('Open this URL to continue in your web browser: https://github.com/login/device');
  if (process.env.FAKE_WEB === 'hang') setInterval(() => {}, 1000);
  else setTimeout(() => { logins[flag('--hostname')] = 'webuser'; save(); }, 300);
} else if (cmd === 'auth login') {
  const token = input.trim();
  if (token !== 'good-token') { console.error('error validating token: HTTP 401: Bad credentials'); process.exit(1); }
  logins[flag('--hostname')] = 'octo';
  save();
} else if (cmd === 'auth logout') {
  delete logins[flag('--hostname')];
  save();
  console.error(`✓ Logged out of ${flag('--hostname')}`);
} else if (cmd === 'auth setup-git') {
  // the real one writes the helper into the global git config; the test only checks it was asked
} else if (cmd === 'ssh-key add') {
  console.log(`✓ Public key added to your account (${args[2]})`);
} else {
  console.error(`unknown command: ${args.join(' ')}`);
  process.exit(1);
}
