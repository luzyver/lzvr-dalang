import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, ClaudeEvents } from '../src/claude.js';
import { parseClaudeModels } from '../src/dispatcher.js';

describe('parseClaudeModels', () => {
  it('reads the /model list from the initialize reply, minus the "default" entry', () => {
    const reply = { type: 'control_response', response: { subtype: 'success', request_id: 'models', response: { models: [
      { value: 'default', displayName: 'Default (recommended)', supportedEffortLevels: ['low'] },
      { value: 'opus', displayName: 'Opus 5.5', description: 'Most capable', supportedEffortLevels: ['low', 'max'] },
      { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5', supportedEffortLevels: null },
    ] } } };
    expect(parseClaudeModels(`{"type":"system"}\nnot json\n${JSON.stringify(reply)}\n`)).toEqual([
      { slug: 'opus', name: 'Opus 5.5', description: 'Most capable', efforts: ['low', 'max'] },
      { slug: 'claude-haiku-4-5', name: 'Haiku 4.5', description: '', efforts: [] },
    ]);
    expect(parseClaudeModels('')).toEqual([]);
  });
});

const run = (events: Record<string, unknown>[]) => {
  const c = new ClaudeEvents();
  return events.flatMap((e) => c.map(e as { type: string }));
};
const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { model: 'claude-x', content } });

describe('ClaudeEvents', () => {
  it('maps a command turn to Codex-shaped events', () => {
    const ev = run([
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'system', subtype: 'init', session_id: 's2' }, // only the first counts
      assistant({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } }),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hi\n', is_error: false }] } },
      assistant({ type: 'text', text: 'done' }),
      { type: 'result', is_error: false, usage: { input_tokens: 3, output_tokens: 4 } },
    ]);
    expect(ev.map((e) => e.type)).toEqual(['thread.started', 'item.started', 'item.completed', 'item.completed', 'turn.completed']);
    expect(ev[0]).toMatchObject({ thread_id: 's1' });
    expect(ev[2]).toMatchObject({ item: { type: 'command_execution', command: 'echo hi', aggregated_output: 'hi\n', exit_code: 0 } });
    expect(ev[3]).toMatchObject({ item: { type: 'agent_message', text: 'done' } });
    expect(ev[4]).toMatchObject({ usage: { input_tokens: 3, output_tokens: 4 } });
  });

  it('maps edits, other tools and thinking', () => {
    const ev = run([assistant(
      { type: 'thinking', thinking: 'hmm' },
      { type: 'tool_use', id: 'a', name: 'Edit', input: { file_path: 'x.ts' } },
      { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'y.ts' } },
    )]);
    expect(ev.map((e) => (e.item as { type: string }).type)).toEqual(['reasoning', 'tool_call']); // the edit waits for its result
    expect(ev[1]).toMatchObject({ item: { tool: 'Read', text: 'y.ts' } });
  });

  it('reports a finished edit or write with the patch from its tool result, and skips failed ones', () => {
    const result = (id: string, tool_use_result: unknown, is_error = false) =>
      ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error }] }, tool_use_result });
    const ev = run([
      assistant({ type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: 'a.txt' } },
        { type: 'tool_use', id: 'w', name: 'Write', input: { file_path: 'b.txt' } },
        { type: 'tool_use', id: 'f', name: 'Edit', input: { file_path: 'c.txt' } }),
      result('e', { filePath: 'a.txt', structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' line1', '-line2', '+LINE TWO', ' line3'] }] }),
      result('w', { type: 'create', filePath: 'b.txt', content: 'hi\nthere\n', structuredPatch: [] }),
      result('f', 'String to replace not found', true),
    ]);
    expect(ev.map((e) => e.item)).toEqual([
      { type: 'file_change', changes: [{ path: 'a.txt', kind: 'update', diff: '@@ -1,3 +1,3 @@\n line1\n-line2\n+LINE TWO\n line3' }] },
      { type: 'file_change', changes: [{ path: 'b.txt', kind: 'add', diff: '@@ -0,0 +1,2 @@\n+hi\n+there' }] },
    ]);
  });

  it('reports an errored result as turn.failed and drops the synthetic duplicate', () => {
    const ev = run([
      { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in' }] } },
      { type: 'result', is_error: true, result: 'Claude AI usage limit reached', terminal_reason: 'api_error' },
    ]);
    expect(ev).toEqual([{ type: 'turn.failed', error: { message: 'Claude AI usage limit reached' } }]);
  });

  it('marks a failure at a usage limit with when it resets, whatever the text says', () => {
    const text = "You've hit your weekly limit · resets Oct 20";
    expect(run([
      { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text }] }, is_api_error_message: true,
        api_error: 'usage_limit_reached', api_error_params: { rate_limit_info: { status: 'rejected', resetsAt: 2000000000 } } },
      { type: 'result', is_error: true, result: text },
    ])).toEqual([{ type: 'turn.failed', error: { message: text }, limit: { resetsAt: 2000000000 } }]);
    // A rejected rate_limit_event counts too; one that is still allowed does not mark anything.
    expect(run([
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000 } },
      { type: 'result', is_error: true, result: 'API Error' },
    ])).toEqual([{ type: 'turn.failed', error: { message: 'API Error' }, limit: { resetsAt: 1900000000 } }]);
    expect(run([
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1900000000 } },
      { type: 'result', is_error: true, result: 'boom' },
    ])).toEqual([{ type: 'turn.failed', error: { message: 'boom' } }]);
  });

  it('marks a process that died after a usage limit without a result', () => {
    const e = new ClaudeEvents();
    e.map({ type: 'assistant', message: { model: '<synthetic>', content: [] }, error: 'rate_limit' });
    expect(e.exit({ type: 'process.exit', code: 1, stderr: '' })).toEqual({ type: 'process.exit', code: 1, stderr: '', limit: {} });
    expect(new ClaudeEvents().exit({ type: 'process.exit', code: 1, stderr: '' })).toEqual({ type: 'process.exit', code: 1, stderr: '' });
  });
});

describe('buildClaudeArgs', () => {
  it('maps the project sandbox to a permission policy and resumes the session', () => {
    const a = buildClaudeArgs({ sandbox: 'workspace-write', threadId: 'sid', model: 'opus', effort: 'high' });
    expect(a).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits', '--allowedTools=Bash', '--model', 'opus', '--effort', 'high', '--resume', 'sid']));
    const readOnly = ['--permission-mode', 'default', '--disallowedTools=Edit,Write,NotebookEdit'];
    expect(buildClaudeArgs({ sandbox: 'read-only' })).toEqual(expect.arrayContaining(readOnly));
    expect(buildClaudeArgs({ sandbox: 'nonsense' })).toEqual(expect.arrayContaining(readOnly)); // unknown sandbox falls back to the safest policy
    expect(buildClaudeArgs({ sandbox: 'read-only' })).not.toContain('plan');
  });

  it('allows the gateway MCP tools when the gateway is given', () => {
    for (const sandbox of ['read-only', 'workspace-write']) {
      expect(buildClaudeArgs({ sandbox, mcpUrl: 'http://127.0.0.1:9876/mcp' })).toEqual(expect.arrayContaining(['--mcp-config', '--allowedTools=mcp__dalang']));
    }
    expect(buildClaudeArgs({ sandbox: 'read-only' })).not.toContain('--allowedTools=mcp__dalang');
  });
});
