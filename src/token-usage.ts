/** Counts reported by a completed turn. Cached input is included in input_tokens. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  reasoning_output_tokens?: number;
}

interface UsageEvent { id: number; type: string; payload: string }
export interface ChatUsage { total: TokenUsage | null; byEvent: Map<number, TokenUsage> }

const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
const fields = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'reasoning_output_tokens'] as const;

/**
 * Codex reports cumulative session counters (identified by cached_input_tokens); Claude reports one process/turn.
 * Keep the stored events unchanged and derive display counts, including old history, using each session's baseline.
 * Explicit usage_scope, when supplied, takes precedence over the legacy shape. A counter reset starts a new baseline.
 */
export function summarizeUsage(events: UsageEvent[]): ChatUsage {
  const sessions = new Map<string, TokenUsage>();
  const byEvent = new Map<number, TokenUsage>();
  let session = '';
  let total: TokenUsage | null = null;
  for (const event of events) {
    let data: { thread_id?: string; usage_scope?: string; usage?: Record<string, unknown> };
    try { data = JSON.parse(event.payload); } catch { continue; }
    if (!data || typeof data !== 'object') continue;
    if (event.type === 'thread.started') {
      session = typeof data.thread_id === 'string' ? data.thread_id : '';
      continue;
    }
    const raw = data.usage;
    if (event.type !== 'turn.completed' || !raw || typeof raw !== 'object'
      || !['input_tokens', 'output_tokens'].some((key) => typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0)) continue;
    const cumulative = data.usage_scope === 'session' || (data.usage_scope !== 'turn' && 'cached_input_tokens' in raw);
    const current: TokenUsage = { input_tokens: count(raw.input_tokens), output_tokens: count(raw.output_tokens) };
    for (const field of fields.slice(2)) if (field in raw) current[field] = count(raw[field]);
    // Claude's input_tokens excludes its cache read/write counters; Codex's already includes them.
    if ('cache_read_input_tokens' in raw || 'cache_creation_input_tokens' in raw) {
      current.cached_input_tokens = count(raw.cache_read_input_tokens);
      current.cache_write_input_tokens = count(raw.cache_creation_input_tokens);
      current.input_tokens += current.cached_input_tokens + current.cache_write_input_tokens;
    }
    const previous = cumulative && session ? sessions.get(session) : undefined;
    const reset = previous && (current.input_tokens < previous.input_tokens || current.output_tokens < previous.output_tokens);
    const usage = { ...current };
    if (previous && !reset) {
      for (const field of fields) if (field in current) usage[field] = Math.max(0, current[field]! - (previous[field] ?? 0));
    }
    if (cumulative && session) sessions.set(session, current);
    if (usage.cached_input_tokens !== undefined) usage.cached_input_tokens = Math.min(usage.input_tokens, usage.cached_input_tokens);
    byEvent.set(event.id, usage);
    total ??= { input_tokens: 0, output_tokens: 0 };
    for (const field of fields) if (field in usage) total[field] = (total[field] ?? 0) + usage[field]!;
  }
  return { total, byEvent };
}
