import { Worker } from 'node:worker_threads';

export interface SearchQuery { query: string; regex?: boolean; matchCase?: boolean; word?: boolean; include?: string; exclude?: string }
export interface SearchMatch { line: number; col: number; len: number; preview: string; at: number }

/** The search as a global regular expression (throws on an invalid regex). */
export function searchRegExp(q: SearchQuery): RegExp {
  let src = q.regex ? q.query : q.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (q.word) src = `\\b(?:${src})\\b`;
  return new RegExp(src, `g${q.matchCase ? '' : 'i'}m`);
}

/** `src/**`, `*.ts, docs/` and the like: comma-separated globs; one without a slash matches any part of the path. */
export function globList(list: string | undefined): RegExp[] {
  return (list ?? '').split(',').map((g) => g.trim()).filter(Boolean).map((g) => {
    const body = g.replace(/\/+$/, '/**').split(/(\*\*\/?|\*|\?)/).map((part) => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }).join('');
    return new RegExp(g.includes('/') ? `^${body}$` : `(^|/)${body}(/|$)`, 'i');
  });
}

/** Every match of `re` in `text` (up to `limit`), with 1-based line and column and a short preview of its line. */
export function findMatches(text: string, re: RegExp, limit: number): SearchMatch[] {
  const out: SearchMatch[] = [];
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  re.lastIndex = 0;
  let line = 0;
  for (let m = re.exec(text); m && out.length < limit; m = re.exec(text)) {
    if (!m[0].length) { re.lastIndex++; continue; } // an empty match (a regex like `x*`) has nothing to show
    while (line + 1 < starts.length && starts[line + 1]! <= m.index) line++;
    const from = starts[line]!;
    const end = line + 1 < starts.length ? starts[line + 1]! - 1 : text.length;
    const lineText = text.slice(from, end).replace(/\r$/, '');
    const col = m.index - from;
    const cut = Math.max(0, col - 60);
    out.push({ line: line + 1, col: col + 1, len: Math.max(1, Math.min(m[0].length, lineText.length - col)), preview: lineText.slice(cut, col + 200), at: col - cut });
  }
  re.lastIndex = 0;
  return out;
}


interface SearchJob { query: SearchQuery; files?: string[]; text?: string; limit?: number; replace?: string }
interface SearchResult { files?: string[]; matches?: SearchMatch[]; text?: string; replacements?: number }

/** Self-contained worker code: user input crosses as data, never as JavaScript source. */
function evaluateSearch(job: SearchJob): SearchResult {
  const re = searchRegExp(job.query);
  if (job.files) {
    const include = globList(job.query.include);
    const exclude = globList(job.query.exclude);
    return { files: job.files.filter((f) => (!include.length || include.some((g) => g.test(f))) && !exclude.some((g) => g.test(f))) };
  }
  const text = job.text!;
  if (job.replace === undefined) return { matches: findMatches(text, re, job.limit!) };
  let replacements = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0].length) re.lastIndex++;
    else replacements++;
  }
  if (!replacements) return { replacements: 0, text };
  re.lastIndex = 0;
  const next = job.query.regex ? text.replace(re, job.replace) : text.replace(re, () => job.replace!);
  if (next.length > 5 * 1024 * 1024) throw new Error('replacement makes a file too large');
  return { replacements, text: next };
}

// Function source works both under tsx/Vitest and in the compiled build without a separate worker loader.
const SOURCE = `import('node:worker_threads').then(({ parentPort }) => {
${searchRegExp.toString()}
${globList.toString()}
${findMatches.toString()}
${evaluateSearch.toString()}
parentPort.on('message', (job) => {
  try { parentPort.postMessage({ result: evaluateSearch(job) }); }
  catch (e) { parentPort.postMessage({ error: e.message }); }
});
});`;

/** One worker per request, bounded both per operation and for the whole request. */
export class SearchWorker {
  private worker = new Worker(SOURCE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 } });
  private stopped = false;
  private closing?: Promise<void>;
  private pending: ((err: Error) => void) | null = null;
  private deadline = setTimeout(() => { this.fail(new Error('search time limit exceeded; narrow the search')); }, 15_000);

  constructor() {
    this.worker.on('error', (e) => this.fail(e));
    this.worker.on('exit', () => this.fail(new Error('search worker stopped')));
  }

  private fail(e: Error): void { this.pending?.(e); void this.close(); }

  run(job: SearchJob): Promise<SearchResult> {
    if (this.stopped) return Promise.reject(new Error('search cancelled or time limit exceeded'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('search time limit exceeded; simplify the expression')), 1500);
      const cleanup = () => { clearTimeout(timer); this.worker.off('message', message); this.pending = null; };
      const message = (m: { error?: string; result: SearchResult }) => {
        cleanup();
        if (m.error) reject(new Error(m.error)); else resolve(m.result);
      };
      this.pending = (e) => { cleanup(); reject(e); };
      this.worker.once('message', message);
      this.worker.postMessage(job);
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    clearTimeout(this.deadline);
    this.pending?.(new Error('search cancelled'));
    this.closing = this.worker.terminate().then(() => {});
    return this.closing;
  }
}
