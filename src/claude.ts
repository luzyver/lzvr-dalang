import { runProcess, type CodexEvent } from './runner.js';

export interface ClaudeTurnOpts {
  command?: string[];
  env?: Record<string, string>;
  /** CLAUDE_CONFIG_DIR of the account (login + sessions live here). */
  home: string;
  cwd: string;
  sandbox: string;
  threadId?: string | null;
  prompt: string;
  model?: string;
  effort?: string;
  /** Gateway MCP endpoint; the bearer token is read from LZVR_MCP_TOKEN in `env`. */
  mcpUrl?: string;
  signal?: AbortSignal;
  killGraceMs?: number;
}

// Claude Code has no OS sandbox, only tool permissions. In headless mode nothing can ask, so each project
// sandbox maps to the closest fixed policy.
// ponytail: workspace-write allows Bash unrestricted (Codex confines it to the workspace); use read-only for untrusted projects.
const PERMISSION: Record<string, string[]> = {
  'read-only': ['--permission-mode', 'plan'],
  'workspace-write': ['--permission-mode', 'acceptEdits', '--allowedTools=Bash'],
  'danger-full-access': ['--permission-mode', 'bypassPermissions'],
};

export function buildClaudeArgs(o: Pick<ClaudeTurnOpts, 'sandbox' | 'threadId' | 'model' | 'effort' | 'mcpUrl'>): string[] {
  const a = ['-p', '--output-format', 'stream-json', '--verbose', ...(PERMISSION[o.sandbox] ?? PERMISSION['read-only']!)];
  if (o.model) a.push('--model', o.model);
  if (o.effort) a.push('--effort', o.effort);
  if (o.mcpUrl) {
    const server = { type: 'http', url: o.mcpUrl, headers: { Authorization: 'Bearer ${LZVR_MCP_TOKEN}' } };
    a.push('--mcp-config', JSON.stringify({ mcpServers: { dalang: server } }));
  }
  if (o.threadId) a.push('--resume', o.threadId);
  return a;
}

type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown>;
  tool_use_id?: string; content?: unknown; is_error?: boolean };

const asText = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: Block) => b.text ?? '').join('\n') : '';

/** One-line description of a tool call for the panel. */
const summary = (input: Record<string, unknown> = {}): string =>
  String(input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? '').slice(0, 200);

/**
 * Translates Claude Code's stream-json into the Codex-shaped events the dispatcher, store and panel already speak
 * (thread.started, item.*, turn.completed / turn.failed).
 */
export class ClaudeEvents {
  private commands = new Map<string, string>(); // Bash tool_use id -> command, until its result arrives
  private started = false;

  map(ev: CodexEvent): CodexEvent[] {
    switch (ev.type) {
      case 'system': {
        if (ev.subtype !== 'init' || this.started || typeof ev.session_id !== 'string') return [];
        this.started = true;
        return [{ type: 'thread.started', thread_id: ev.session_id }];
      }
      case 'assistant': return this.assistant(ev);
      case 'user': return this.toolResults(ev);
      case 'result': {
        if (ev.is_error) {
          const message = String(ev.result || ev.terminal_reason || ev.subtype || 'Claude Code failed');
          return [{ type: 'turn.failed', error: { message } }];
        }
        const u = (ev.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
        return [{ type: 'turn.completed', usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens } }];
      }
      case 'rate_limit_event': return this.limits(ev);
      default: return []; // stream_event, ...
    }
  }

  /** Both rate windows Claude reports (utilization is 0-1), as the account's usage for the panel. */
  private limits(ev: CodexEvent): CodexEvent[] {
    const info = ev.rate_limit_info as { unifiedWindows?: Record<string, { utilization: number; resetsAt: number }> } | undefined;
    const names: Record<string, string> = { five_hour: '5h', seven_day: '7d' };
    const windows = Object.entries(info?.unifiedWindows ?? {}).filter(([k]) => names[k])
      .map(([k, w]) => ({ label: names[k]!, usedPercent: Math.round(w.utilization * 1000) / 10, resetsAt: w.resetsAt }));
    return windows.length ? [{ type: 'account.limits', windows }] : [];
  }

  private blocks(ev: CodexEvent): Block[] {
    const m = ev.message as { content?: unknown; model?: string } | undefined;
    // Synthetic assistant messages only repeat the error the `result` event reports.
    if (!m || m.model === '<synthetic>' || !Array.isArray(m.content)) return [];
    return m.content as Block[];
  }

  private assistant(ev: CodexEvent): CodexEvent[] {
    const out: CodexEvent[] = [];
    for (const b of this.blocks(ev)) {
      if (b.type === 'text' && b.text) out.push({ type: 'item.completed', item: { type: 'agent_message', text: b.text } });
      else if (b.type === 'thinking' && b.thinking) out.push({ type: 'item.completed', item: { type: 'reasoning', text: b.thinking } });
      else if (b.type === 'tool_use') {
        const name = b.name ?? 'tool';
        if (name === 'Bash' && b.id) {
          const command = String(b.input?.command ?? '');
          this.commands.set(b.id, command);
          out.push({ type: 'item.started', item: { id: b.id, type: 'command_execution', command, status: 'in_progress' } });
        } else if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) {
          const path = String(b.input?.file_path ?? b.input?.notebook_path ?? '');
          out.push({ type: 'item.completed', item: { type: 'file_change', changes: [{ kind: name === 'Write' ? 'write' : 'edit', path }] } });
        } else {
          out.push({ type: 'item.completed', item: { type: 'tool_call', tool: name, text: summary(b.input) } });
        }
      }
    }
    return out;
  }

  private toolResults(ev: CodexEvent): CodexEvent[] {
    const out: CodexEvent[] = [];
    for (const b of this.blocks(ev)) {
      if (b.type !== 'tool_result' || !b.tool_use_id || !this.commands.has(b.tool_use_id)) continue;
      const command = this.commands.get(b.tool_use_id)!;
      this.commands.delete(b.tool_use_id);
      // Claude Code reports no exit code, only whether the tool errored.
      out.push({ type: 'item.completed', item: {
        id: b.tool_use_id, type: 'command_execution', command, aggregated_output: asText(b.content), exit_code: b.is_error ? 1 : 0, status: 'completed',
      } });
    }
    return out;
  }
}

export async function* runClaudeTurn(o: ClaudeTurnOpts): AsyncGenerator<CodexEvent> {
  const events = new ClaudeEvents();
  for await (const ev of runProcess({
    command: o.command ?? ['claude'], args: buildClaudeArgs(o), env: { ...o.env, CLAUDE_CONFIG_DIR: o.home },
    cwd: o.cwd, prompt: o.prompt, signal: o.signal, killGraceMs: o.killGraceMs,
  })) {
    if (ev.type === 'process.exit' || ev.type === 'raw') yield ev;
    else yield* events.map(ev);
  }
}
