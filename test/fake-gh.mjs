// Fake `gh` / `glab`: `fake-gh.mjs <log file> <args...>`. Appends its arguments and folder to the log as a JSON line and
// prints a new pull request address; once the log has an entry, it answers like gh does for a branch that has one already.
// `pr view` and `api` answer with a pull request that has checks, a review and comments (merged once `pr merge` ran);
// `pr merge` is logged too.
// Accounts: FAKE_GH_ACCOUNTS="ann,bob*" signs in ann and bob on github.com (* = active; none set = not signed in), each
// with token `tok-<user>`; FAKE_GH_WRITERS="bob" are the ones that may push to the repository. Every logged call
// records the GH_TOKEN it ran with.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const [log, ...args] = process.argv.slice(2);
const url = 'https://github.com/acme/app/pull/7';
const merged = () => existsSync(log) && readFileSync(log, 'utf8').includes('"merge"');
const token = process.env.GH_TOKEN ?? null;
const accounts = (process.env.FAKE_GH_ACCOUNTS ?? '').split(',').filter(Boolean)
  .map((a) => ({ user: a.replace('*', ''), active: a.endsWith('*') }));

if (args[0] === 'auth' && args[1] === 'status') {
  if (!accounts.length) { console.error('You are not logged into any GitHub hosts.'); process.exit(1); }
  console.log('github.com');
  for (const a of accounts) console.log(`  ✓ Logged in to github.com account ${a.user} (keyring)\n  - Active account: ${a.active}`);
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'token') {
  const user = args[args.indexOf('--user') + 1];
  if (!accounts.some((a) => a.user === user)) { console.error(`no account found for ${user}`); process.exit(1); }
  console.log(`tok-${user}`);
  process.exit(0);
}
if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+$/.test(args[3] ?? '')) {
  const writers = (process.env.FAKE_GH_WRITERS ?? '').split(',');
  console.log(String(writers.some((w) => token === `tok-${w}`)));
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'view') {
  console.log(JSON.stringify({
    title: 'feat: Add b', url, state: merged() ? 'MERGED' : 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: 'CHANGES_REQUESTED',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci.example/1' },
      { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: '' },
      { __typename: 'StatusContext', context: 'deploy', state: 'SUCCESS', targetUrl: '' },
    ],
    comments: [{ author: { login: 'ann' }, body: 'Looks close.', createdAt: '2026-01-01T10:00:00Z' }],
    reviews: [{ author: { login: 'bob' }, body: 'Please rename x.', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T11:00:00Z' }],
  }));
  process.exit(0);
}
if (args[0] === 'api') {
  console.log(JSON.stringify([{ user: { login: 'bob' }, body: 'Off by one here.', path: 'b.txt', line: 1, created_at: '2026-01-01T12:00:00Z' }]));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'merge') {
  appendFileSync(log, `${JSON.stringify({ args, cwd: process.cwd(), leaked: process.env.LZVR_TOKEN ?? null, token, merge: true })}\n`);
  process.exit(0);
}
if (existsSync(log)) {
  console.error(`a pull request for branch "x" into branch "main" already exists:\n${url}`);
  process.exit(1);
}
appendFileSync(log, `${JSON.stringify({ args, cwd: process.cwd(), leaked: process.env.LZVR_TOKEN ?? null, token })}\n`);
console.log('Creating pull request for x into main in acme/app\n');
console.log(url);
