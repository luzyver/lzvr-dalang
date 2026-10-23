// What the panel needs of a stored event. A long chat's history is mostly tool output (command output, diffs, long
// thoughts) that the thread only shows when a step is opened, so the panel gets those cut and fetches one event in full
// when it is opened (GET /api/conversations/:id/events/:eventId).

/** Text longer than this is cut; a payload no longer than twice it is passed on as it is, without parsing it. */
export const CUT = 2000;

type Item = Record<string, unknown> & { type?: unknown };

const long = (v: unknown): v is string => typeof v === 'string' && v.length > CUT;

/** Added and removed lines of a unified diff, as the panel counts them (diffStats in public/js/diff.js). */
export function diffStat(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+')) add++;
    else if (l.startsWith('-')) del++;
  }
  return { add, del };
}

/** An item with its long fields cut; `cut: true` marks one the panel fetches in full when it is opened. */
function compactItem(item: Item): Item {
  switch (item.type) {
    case 'agent_message':
    case 'error':
      return item; // what the thread shows as it is
    case 'command_execution': {
      if (!long(item.aggregated_output) && !long(item.command)) return item;
      return { ...item, command: long(item.command) ? `${item.command.slice(0, CUT)}…` : item.command, aggregated_output: '', cut: true };
    }
    case 'file_change': {
      if (!Array.isArray(item.changes)) return item;
      let cut = false;
      const changes = item.changes.map((c: Record<string, unknown>) => {
        if (!c || !long(c.diff)) return c;
        cut = true;
        return { ...c, diff: '', stat: diffStat(c.diff) };
      });
      return cut ? { ...item, changes, cut } : item;
    }
    case 'reasoning':
    case 'tool_call':
      return long(item.text) ? { ...item, text: `${item.text.slice(0, CUT)}…`, cut: true } : item;
    default:
      return { id: item.id, type: item.type, cut: true }; // the thread shows only its kind; the rest is in the full event
  }
}

/**
 * An event's payload as the panel's thread gets it: long tool output cut, and null for an event the thread does not
 * use (item.updated, which repeats an item while it runs).
 */
export function compactPayload(type: string, payload: string): string | null {
  if (type === 'item.updated') return null;
  if (payload.length <= CUT * 2 || (type !== 'item.completed' && type !== 'item.started')) return payload;
  let ev: { item?: unknown };
  try { ev = JSON.parse(payload) as { item?: unknown }; } catch { return payload; }
  if (!ev || typeof ev.item !== 'object' || ev.item === null) return payload;
  return JSON.stringify({ ...ev, item: compactItem(ev.item as Item) });
}
