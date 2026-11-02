import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { insideRoot } from './paths.js';
import { REVIEWER_ROLE, reviewDiffDir } from './reviewer.js';
import type { Store } from './store.js';

/** Lines one call returns at most; `next_offset` pages on. */
const PAGE_MAX = 2000;
/** Files larger than this are not read (a build output or a dump, not code under review). */
const FILE_MAX = 8e6;

const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });
const fail = (m: string) => ({ isError: true, content: [{ type: 'text' as const, text: m }] });

/** Lines `offset`.. of a text, at most `limit` of them, numbered from 1 like an editor. */
function page(body: string, offset = 1, limit = PAGE_MAX) {
  const lines = body.split(/\r?\n/);
  const from = Math.max(1, offset);
  const shown = lines.slice(from - 1, from - 1 + Math.min(limit, PAGE_MAX));
  const next = from + shown.length;
  return { total_lines: lines.length, offset: from, text: shown.map((l, i) => `${from + i}\t${l}`).join('\n'), ...(next <= lines.length && { next_offset: next }) };
}

const PAGING = {
  offset: z.number().int().min(1).optional().describe('first line (1-based; default 1)'),
  limit: z.number().int().min(1).max(PAGE_MAX).optional().describe(`lines to return (at most ${PAGE_MAX})`),
};

/**
 * What a reviewer reads with when its own shell refuses even reads (Codex's read-only sandbox may block every
 * command; Claude Code's cannot ask): the whole diff it is to review, and the files of the chat it reviews. Only for
 * a reviewer's chat, only reads, and only inside that chat's folder.
 */
export function reviewTools(server: McpServer, store: Store, source: string | null): void {
  const rev = source ? store.getConversation(source) : null;
  if (!rev || rev.role !== REVIEWER_ROLE) return;
  const folder = () => {
    const reviewed = store.getConversation(rev.parent ?? '');
    const project = reviewed && store.getProject(reviewed.project_id);
    return project ? reviewed.worktree ?? project.path : null;
  };

  server.registerTool('review_diff', {
    description: 'The whole diff of the change you review (the prompt holds only its start), by lines.',
    inputSchema: PAGING,
  }, async ({ offset, limit }) => {
    try { return text(page(readFileSync(join(reviewDiffDir(rev.id), 'change.diff'), 'utf8'), offset, limit)); } catch {
      return fail('no diff file for this review: rely on the diff in the prompt');
    }
  });

  server.registerTool('review_read_file', {
    description: 'Read a file of the folder under review, by lines; a directory gives its entries. Path relative to that folder.',
    inputSchema: { path: z.string().describe("e.g. src/app.ts, or '.' for the top"), ...PAGING },
  }, async ({ path, offset, limit }) => {
    const root = folder();
    const real = root && insideRoot(root, path || '.');
    if (!real) return fail(`not in the folder under review: ${path}`);
    try {
      const st = statSync(real);
      if (st.isDirectory()) {
        return text({ entries: readdirSync(real, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort() });
      }
      if (st.size > FILE_MAX) return fail(`${path} is too large to read here (${st.size} bytes)`);
      return text(page(readFileSync(real, 'utf8'), offset, limit));
    } catch (e) { return fail((e as Error).message); }
  });
}
