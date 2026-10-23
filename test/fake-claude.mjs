// Fake `claude -p --output-format stream-json`. A CLAUDE_CONFIG_DIR basename listed in FAKE_LIMIT_HOMES hits a usage limit.
import { basename } from 'node:path';

const args = process.argv.slice(2);
const out = (o) => console.log(JSON.stringify(o));
const sid = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'sess-1';
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) prompt += c;

out({ type: 'system', subtype: 'init', session_id: sid });
const context = process.env.FAKE_CONTEXT ? JSON.parse(process.env.FAKE_CONTEXT) : null;
if (context?.compacted) {
  out({ type: 'system', subtype: 'status', status: 'compacting' });
  out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } });
}
if ((process.env.FAKE_LIMIT_HOMES || '').split(',').includes(basename(process.env.CLAUDE_CONFIG_DIR || ''))) {
  // As Claude Code 2.1 reports it: the text alone matches no older limit wording; the typed api_error says what it is.
  const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600;
  const text = "You've hit your session limit · resets 3pm";
  out({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text }] }, error: 'rate_limit', is_api_error_message: true,
    api_error: 'usage_limit_reached', api_error_params: { rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' } } });
  out({ type: 'result', subtype: 'success', is_error: true, result: text });
  process.exit(1);
}
out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.125, resetsAt: 2000000000 } } } });
out({ type: 'assistant', message: { model: 'claude-x', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hi', is_error: false }] } });
out({ type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: `echo:${prompt}|${basename(process.env.CLAUDE_CONFIG_DIR || '')}${args.includes('--append-system-prompt') ? `|system:${args[args.indexOf('--append-system-prompt') + 1]}` : ''}${args.includes('--settings') ? `|settings:${args[args.indexOf('--settings') + 1]}|root:${process.env.LZVR_CODE_ROOT}` : ''}${args.find((a) => a.startsWith('--add-dir=')) ? `|${args.find((a) => a.startsWith('--add-dir='))}` : ''}${process.env.GIT_CONFIG_COUNT ? `|gitcfg:${process.env.GIT_CONFIG_COUNT}` : ''}` }] } });
if (context) out({ type: 'assistant', message: { model: 'claude-x', content: [], usage: { input_tokens: context.tokens - 100, cache_read_input_tokens: 100 } } });
if (context) out({ type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: `compact-window:${process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || 'unset'}` }] } });
out({ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 2 }, ...(context && { modelUsage: { 'claude-x': { contextWindow: context.window } } }) });
