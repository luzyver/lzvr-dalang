import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { DRIVERS, runScript, readSchema, streamStatement, type DbConnection } from '../src/databases.js';
import { setupApp } from './setup-app.js';
import { AUTH } from './helpers.js';

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); });
async function fixture(handler: (path: string, body: any, method: string) => unknown) {
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(handler(req.url!, text ? JSON.parse(text) : null, req.method!)));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  close.push(() => new Promise<void>(r => server.close(() => r())));
  return { id: 'es', label: 'Elastic', driver: 'elasticsearch', host: '127.0.0.1', port: (server.address() as any).port,
    user: '', password: '', database: '', ssl: 'disable', file: '', access: 'admin', readOnly: true, agent: 'off' } as DbConnection;
}
const opts = { readOnly: true, limit: 2, timeoutMs: 1000 };
const hit = (id: number) => ({ _index: 'books', _id: String(id), _score: 1, _source: { title: `Book ${id}` } });
it('registers Elasticsearch and returns bounded documents without splitting JSON semicolons', async () => {
  expect(DRIVERS).toContain('elasticsearch');
  const c = await fixture((path, body) => {
    expect(path).toBe('/books/_search'); expect(body.query).toEqual({ match: { title: 'a;b' } });
    return { hits: { total: { value: 3, relation: 'eq' }, hits: [hit(1), hit(2), hit(3)] } };
  });
  const [r] = await runScript(c, '{"index":"books","query":{"match":{"title":"a;b"}}}', opts);
  expect(r!.rows).toHaveLength(2); expect(r!.truncated).toBe(true);
  expect(r!.rows[0]).toContain('{"title":"Book 1"}');
});
it('rejects paths and non-object requests before making HTTP calls', async () => {
  let calls = 0; const c = await fixture(() => { calls++; return {}; });
  for (const sql of ['DELETE /books', '[]', '{"index":"../_security"}', '{"index":"books?x=y"}']) {
    await expect(runScript(c, sql, opts)).rejects.toThrow();
  }
  expect(calls).toBe(0);
});
it('exposes nested mapping fields', async () => {
  const c = await fixture(() => ({ books: { mappings: { properties: { author: { properties: { name: { type: 'keyword' } } } } } } }));
  const schema = await readSchema(c);
  expect(schema.schemas[0]!.tables[0]!.columns).toContainEqual({ name: 'author.name', type: 'keyword', nullable: true, pk: false });
});
it('exports multiple batches and clears the final scroll id', async () => {
  let cleared = ''; let page = 0;
  const c = await fixture((path, body, method) => {
    if (method === 'DELETE') { cleared = body.scroll_id[0]; return { succeeded: true }; }
    if (path.startsWith('/books/_search')) return { _scroll_id: 'first', hits: { hits: [hit(1), hit(2)] } };
    expect(path).toBe('/_search/scroll');
    return { _scroll_id: 'last', hits: { hits: page++ ? [] : [hit(3)] } };
  });
  const rows: unknown[][] = [];
  await streamStatement(c, '{"index":"books"}', { timeoutMs: 1000 }, { columns: async () => {}, rows: async r => { rows.push(...r); return true; } });
  expect(rows).toHaveLength(3); expect(cleared).toBe('last');
});
it('surfaces partial search failure instead of exporting incomplete data', async () => {
  const c = await fixture(() => ({ timed_out: true, hits: { hits: [] } }));
  await expect(runScript(c, '{"index":"books"}', opts)).rejects.toThrow(/timed out/i);
});
it('marks a large explicit size as truncated at the preview window', async () => {
  const c = await fixture((_path, body) => ({ hits: { hits: Array.from({ length: body.size }, (_, i) => hit(i)) } }));
  const [r] = await runScript(c, '{"index":"books","size":20000}', { ...opts, limit: 100000 });
  expect(r!.truncated).toBe(true);
});
it('keeps aggregation results as JSON alongside document results', async () => {
  const c = await fixture(() => ({ hits: { hits: [hit(1)] }, aggregations: { count: { value: 5 } } }));
  const r = await runScript(c, '{"index":"books","aggs":{"count":{"value_count":{"field":"title"}}}}', opts);
  expect(r).toHaveLength(2);
  expect(JSON.parse(String(r[1]!.rows[0]![0]))).toEqual({ aggregations: { count: { value: 5 } } });
});
it('clears the scroll when the export consumer stops', async () => {
  let cleared = false;
  const c = await fixture((_path, _body, method) => {
    if (method === 'DELETE') { cleared = true; return {}; }
    return { _scroll_id: 'stop', hits: { hits: [hit(1)] } };
  });
  await streamStatement(c, '{"index":"books"}', opts, { columns: async () => {}, rows: async () => false });
  expect(cleared).toBe(true);
});
it('honors cancellation before issuing a search', async () => {
  let calls = 0; const c = await fixture(() => { calls++; return {}; });
  await expect(runScript(c, '{}', { ...opts, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(calls).toBe(0);
});
it('refuses offsets outside the preview window rather than returning an empty page', async () => {
  let calls = 0; const c = await fixture(() => { calls++; return { hits: { hits: [] } }; });
  await expect(runScript(c, '{"index":"books","from":10000}', opts)).rejects.toThrow(/10,000/);
  expect(calls).toBe(0);
});
it('saves connections as read-only and never exposes saved credentials', async () => {
  const t = setupApp(); close.push(() => t.app.close());
  const c = await fixture(() => ({ hits: { hits: [hit(1)] } }));
  const { id, file, ...payload } = c;
  const saved = await t.app.inject({ method: 'PUT', url: '/api/db/connections/es', headers: AUTH,
    payload: { ...payload, password: 'fixture-secret', readOnly: false, agent: 'read-write' } });
  expect(saved.statusCode).toBe(200);
  const list = await t.app.inject({ url: '/api/db/connections', headers: AUTH });
  expect(list.json()[0]).toMatchObject({ readOnly: true, agent: 'read-only', hasPassword: true });
  expect(list.body).not.toContain('fixture-secret');
  const query = await t.app.inject({ method: 'POST', url: '/api/db/connections/es/query', headers: AUTH, payload: { sql: '{"index":"books"}' } });
  expect(query.statusCode).toBe(200); expect(query.json().results[0].rows).toHaveLength(1);
});

it('limits string, document and aggregation cells only when maxCell is supplied', async () => {
  const c = await fixture(() => ({ hits: { hits: [{ ...hit(1), _id: 'abcdefgh', _source: { title: 'long title' } }] }, aggregations: { count: { value: 5 } } }));
  const limited = await runScript(c, '{}', { ...opts, maxCell: 5 });
  expect(limited[0]!.rows[0]).toEqual(['books', 'abcde…', 1, '{"tit…', null, null, null]);
  expect(limited[1]!.rows).toEqual([['{"agg…']]);
  for (const maxCell of [undefined, Infinity]) {
    const full = await runScript(c, '{}', { ...opts, maxCell });
    expect(full[0]!.rows[0]![3]).toBe('{"title":"long title"}');
    expect(full[1]!.rows[0]![0]).toBe('{"aggregations":{"count":{"value":5}}}');
  }
});

it.each([{ from: 1 }, { search_after: [1] }, { collapse: { field: 'author' } }, { pit: { id: 'p' } }, { aggs: {} }, { aggregations: {} }, { suggest: {} }])(
  'marks unsupported download-all queries while preserving displayed rows: %j', async body => {
    const c = await fixture(() => ({ hits: { hits: [hit(1), hit(2), hit(3)] } }));
    const [r] = await runScript(c, JSON.stringify(body), opts);
    expect(r).toMatchObject({ truncated: true, canExportAll: false });
    expect(r!.rows).toHaveLength(2);
    await expect(streamStatement(c, JSON.stringify(body), opts, { columns: async () => {}, rows: async () => true })).rejects.toThrow(/displayed result/);
  }
);
it('offers download-all for ordinary truncated searches', async () => {
  const c = await fixture(() => ({ hits: { hits: [hit(1), hit(2), hit(3)] } }));
  expect((await runScript(c, '{}', opts))[0]).toMatchObject({ truncated: true, canExportAll: true });
});
it('rejects early-terminated documents and aggregations', async () => {
  const c = await fixture(() => ({ terminated_early: true, hits: { hits: [hit(1)] }, aggregations: { count: { value: 1 } } }));
  await expect(runScript(c, '{"terminate_after":1}', opts)).rejects.toThrow(/terminated early/i);
});
it.each([true, false])('rejects early termination during export and clears the cursor (first page: %s)', async first => {
  let cleared = false; let delivered = 0;
  const c = await fixture((path, _body, method) => {
    if (method === 'DELETE') { cleared = true; return {}; }
    return { _scroll_id: 'cursor', terminated_early: first || path === '/_search/scroll', hits: { hits: [hit(1)] } };
  });
  await expect(streamStatement(c, '{}', opts, { columns: async () => {}, rows: async () => { delivered++; return true; } })).rejects.toThrow(/terminated early/i);
  expect(delivered).toBe(first ? 0 : 1);
  expect(cleared).toBe(true);
});
