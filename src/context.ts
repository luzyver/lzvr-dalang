/** A native compaction window, not cumulative usage or a limit on the person's prompt. */
export const DEFAULT_COMPACT_TOKENS = 100_000;

export interface ContextUsage {
  tokens: number;
  window?: number;
}

/** Keep resumable work and user constraints in the CLI's checkpoint; older detail stays in Dalang's event history. */
export function contextGuide(convId?: string): string {
  return 'When compacting context, preserve the original goal, user constraints and corrections, decisions, changed files, '
    + 'verification results and unfinished work. Keep recent exchanges and references needed to continue; do not repeat completed actions.'
    + (convId ? ` Earlier messages remain in Dalang: use get_events with conversation_id="${convId}", messages_only=true, last_turns=3; `
      + 'earlier_before_turn pages back. Fetch only missing details; use full events when tool output is needed.' : '');
}
