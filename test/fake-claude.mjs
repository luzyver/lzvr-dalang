// Fake `claude -p --output-format stream-json`. A CLAUDE_CONFIG_DIR basename listed in FAKE_LIMIT_HOMES hits a usage limit.
import { basename } from 'node:path';

const args = process.argv.slice(2);
const out = (o) => console.log(JSON.stringify(o));
const sid = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'sess-1';
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) prompt += c;

out({ type: 'system', subtype: 'init', session_id: sid });
if ((process.env.FAKE_LIMIT_HOMES || '').split(',').includes(basename(process.env.CLAUDE_CONFIG_DIR || ''))) {
  out({ type: 'result', is_error: true, result: 'Claude AI usage limit reached' });
  process.exit(1);
}
out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.125, resetsAt: 2000000000 } } } });
out({ type: 'assistant', message: { model: 'claude-x', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hi', is_error: false }] } });
out({ type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: `echo:${prompt}|${basename(process.env.CLAUDE_CONFIG_DIR || '')}` }] } });
out({ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 2 } });
