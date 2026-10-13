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
    expect(ev.map((e) => (e.item as { type: string }).type)).toEqual(['reasoning', 'file_change', 'tool_call']);
    expect(ev[1]).toMatchObject({ item: { changes: [{ kind: 'edit', path: 'x.ts' }] } });
    expect(ev[2]).toMatchObject({ item: { tool: 'Read', text: 'y.ts' } });
  });

  it('reports an errored result as turn.failed and drops the synthetic duplicate', () => {
    const ev = run([
      { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in' }] } },
      { type: 'result', is_error: true, result: 'Claude AI usage limit reached', terminal_reason: 'api_error' },
    ]);
    expect(ev).toEqual([{ type: 'turn.failed', error: { message: 'Claude AI usage limit reached' } }]);
  });
});

describe('buildClaudeArgs', () => {
  it('maps the project sandbox to a permission policy and resumes the session', () => {
    const a = buildClaudeArgs({ sandbox: 'workspace-write', threadId: 'sid', model: 'opus', effort: 'high' });
    expect(a).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits', '--allowedTools=Bash', '--model', 'opus', '--effort', 'high', '--resume', 'sid']));
    expect(buildClaudeArgs({ sandbox: 'read-only' })).toContain('plan');
    expect(buildClaudeArgs({ sandbox: 'nonsense' })).toContain('plan'); // unknown sandbox falls back to the safest policy
  });
});
