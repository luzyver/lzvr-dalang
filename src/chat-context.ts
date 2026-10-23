import { queryTerms } from './memory.js';

interface HistoryTurn { id?: number; prompt: string; answer: string }
interface Recovery { conversationId: string; beforeTurn: number }

/** Excerpts keep both the opening context and the conclusion/correction at the end. */
function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = '\n[...excerpt...]\n';
  const room = max - marker.length;
  const head = Math.ceil(room * .6);
  return text.slice(0, head) + marker + text.slice(-(room - head));
}

/**
 * A new CLI session gets a bounded handoff, not the entire transcript. With MCP available, keep the original task,
 * the last two exchanges and relevant older ones in 12k characters; full messages can be fetched on demand.
 * Without MCP, retain the previous 40k fallback because the new session cannot fetch the omitted messages.
 * The current request is always passed through in full, outside the handoff budget.
 */
export function withHistory(turns: HistoryTurn[], prompt: string, recovery?: Recovery): string {
  if (!turns.length) return prompt;
  if (!recovery) return fallbackHistory(turns, prompt);

  const intro = 'This chat continues in a new agent session. Earlier turns below are excerpts, not a complete transcript. '
    + 'Keep the original goal and later corrections. Tool output is omitted: check files/state before continuing.\n'
    + `For missing details, use dalang get_events with conversation_id="${recovery.conversationId}", messages_only=true, `
    + `last_turns=3, before_turn=${recovery.beforeTurn}. For stored turn T, use last_turns=1, before_turn=T+1. `
    + 'Page earlier with earlier_before_turn. Fetch only what you need.\n\n<earlier_turns>\n';
  const end = '\n</earlier_turns>\n\nNew request:\n';
  const max = 12_000 - intro.length - end.length;
  const selected = new Map<number, string>();
  let size = 0;
  const take = (index: number, promptMax: number, answerMax: number) => {
    if (selected.has(index)) return;
    const turn = turns[index]!;
    const part = `### Turn ${index + 1}${turn.id === undefined ? '' : ` (stored turn ${turn.id})`}\nAsked:\n`
      + `${excerpt(turn.prompt, promptMax)}\n\nAnswered:\n${excerpt(turn.answer, answerMax) || '(no answer)'}`;
    if (size + part.length + (selected.size ? 2 : 0) > max) return;
    selected.set(index, part);
    size += part.length + (selected.size > 1 ? 2 : 0);
  };
  if (turns.length > 2) take(0, 1200, 800);
  for (let i = turns.length - 1; i >= Math.max(0, turns.length - 2); i--) take(i, 1600, 2400);

  const terms = new Set(queryTerms(prompt));
  const candidates = turns.map((turn, index) => ({ index,
    score: queryTerms(`${turn.prompt}\n${turn.answer}`).filter((word) => terms.has(word)).length,
  })).filter(({ index }) => !selected.has(index));
  candidates.sort((a, b) => b.score - a.score || b.index - a.index);
  for (const { index } of candidates) take(index, 400, 800);
  const parts = [...selected].sort(([a], [b]) => a - b).map(([, part]) => part);
  return intro + parts.join('\n\n') + end + prompt;
}

function fallbackHistory(turns: HistoryTurn[], prompt: string): string {
  const cut = (s: string, max: number) => s.length > max ? `${s.slice(0, max)} [...]` : s;
  const parts: string[] = [];
  let size = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    const part = `### Turn ${i + 1}\nAsked:\n${cut(t.prompt, 2000)}\n\nAnswered:\n${cut(t.answer, 4000) || '(no answer)'}`;
    if (size + part.length > 40_000 && parts.length) break;
    parts.unshift(part);
    size += part.length;
  }
  const dropped = turns.length - parts.length;
  return 'This chat began in another agent session, which you cannot see. What was asked in it and answered so far '
    + `is below${dropped ? ` (its first ${dropped} turn(s) left out)` : ''}; commands and tool output are not kept, `
    + 'so check files and state yourself before relying on it.\n\n'
    + `<earlier_turns>\n${parts.join('\n\n')}\n</earlier_turns>\n\nNew request:\n${prompt}`;
}
