// Fake `ssh` for Settings → Git: answers `ssh -T git@host` like GitHub does (stderr, exit 1) for github.com and its
// `github.com-*` aliases, and `ssh -G` with an alias resolved to github.com and its own key. Logs its arguments.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'ssh.log'), `${JSON.stringify(args)}\n`);
const target = args[args.length - 1];
const host = target.replace(/^[^@]*@/, '');
if (args.includes('-G')) {
  const alias = host.startsWith('github.com-');
  console.log(`host ${host}\nhostname ${alias ? 'github.com' : host}\nuser git\nport 22`);
  if (alias) console.log(`identityfile ~/.ssh/id_${host.slice('github.com-'.length)}`);
  console.log('identityfile ~/.ssh/id_rsa\nidentityfile ~/.ssh/id_ed25519');
  process.exit(0);
}
const ok = target === 'git@github.com' || target.startsWith('git@github.com-');
if (ok) console.error("Hi octo! You've successfully authenticated, but GitHub does not provide shell access.");
else console.error(`${target}: Permission denied (publickey).`);
process.exit(ok ? 1 : 255);
