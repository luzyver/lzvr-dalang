// Fake `codex`. exec: FAKE_MODE ok (default) | fail | slow | stubborn | rawline. FAKE_ECHO_ARGS=1: answer with argv, not the prompt.
// FAKE_LIMIT_HOMES=a,b: any exec whose CODEX_HOME basename is listed fails with a usage-limit error.
// login: `login status` succeeds iff $CODEX_HOME/auth.json exists; `login --device-auth` behaves per
// FAKE_LOGIN = succeed (default) | succeed-noauth | fail | hang.
import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);

if (args[0] === 'login') {
  const home = process.env.CODEX_HOME || '';
  if (args[1] === 'status') {
    const ok = existsSync(join(home, 'auth.json'));
    console.log(ok ? 'Logged in using ChatGPT' : 'Not logged in');
    process.exit(ok ? 0 : 1);
  }
  const mode = process.env.FAKE_LOGIN || 'succeed';
  console.log('\u001b[1mOpen\u001b[0m https://auth.example.test/device and enter the code ABCD-1234');
  if (mode === 'hang') await new Promise((r) => setTimeout(r, 30000));
  await new Promise((r) => setTimeout(r, 80));
  if (mode === 'fail') {
    console.error('device code expired');
    process.exit(1);
  }
  if (mode !== 'succeed-noauth') writeFileSync(join(home, 'auth.json'), '{}');
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  const out = (e) => console.log(JSON.stringify(e));
  const home = process.env.CODEX_HOME || '';
  const i = args.indexOf('resume');
  const threadId = i >= 0 ? args[i + 1] : `thread-${process.pid}`;
  out({ type: 'thread.started', thread_id: threadId });
  out({ type: 'turn.started' });
  const mode = process.env.FAKE_MODE || 'ok';
  const limited = (process.env.FAKE_LIMIT_HOMES || '').split(',').filter(Boolean);
  if (limited.includes(basename(home))) {
    if (process.env.FAKE_LIMIT_AFTER_WORK) out({ type: 'item.completed', item: { type: 'command_execution', command: 'ls' } });
    out({ type: 'turn.failed', error: { message: process.env.FAKE_LIMIT_MESSAGE || 'You have reached your usage limit' } });
    process.exit(1);
  }
  if (mode === 'rawline') { // a line whose exact text would not survive JSON.parse + JSON.stringify
    console.log('{"type":"item.completed","item":{"type":"agent_message","text":"x","big":12345678901234567890}}');
    console.log('{"type":"turn.completed","usage":{"input_tokens":1}}');
    return;
  }
  if (mode === 'stubborn') process.on('SIGTERM', () => {}); // ignores polite kills
  if (mode === 'slow' || mode === 'stubborn') await new Promise((r) => setTimeout(r, 30000));
  if (mode === 'fail') {
    out({ type: 'turn.failed', error: { message: 'boom' } });
    process.exit(1);
  }
  out({
    type: 'item.completed',
    item: { type: 'agent_message', text: process.env.FAKE_ECHO_ARGS ? JSON.stringify(args) : input, args, home, mcpToken: process.env.LZVR_MCP_TOKEN, leaked: process.env.LZVR_TOKEN },
  });
  out({
    type: 'turn.completed',
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
  });
});
