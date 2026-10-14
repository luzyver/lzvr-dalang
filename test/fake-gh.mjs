// Fake `gh` / `glab`: `fake-gh.mjs <log file> <args...>`. Appends its arguments and folder to the log as a JSON line and
// prints a new pull request address; once the log has an entry, it answers like gh does for a branch that has one already.
import { appendFileSync, existsSync } from 'node:fs';

const [log, ...args] = process.argv.slice(2);
const url = 'https://github.com/acme/app/pull/7';
if (existsSync(log)) {
  console.error(`a pull request for branch "x" into branch "main" already exists:\n${url}`);
  process.exit(1);
}
appendFileSync(log, `${JSON.stringify({ args, cwd: process.cwd(), leaked: process.env.LZVR_TOKEN ?? null })}\n`);
console.log('Creating pull request for x into main in acme/app\n');
console.log(url);
