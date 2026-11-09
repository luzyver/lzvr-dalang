/** Read-only Elasticsearch transport. Query text is a JSON search body plus an optional index. */
import { request as http } from 'node:http';
import { request as https } from 'node:https';
import { tlsServer } from './ssh-tunnel.js';
import type { Column, DbConnection, QueryResult, RowSink, RunOpts, SchemaColumn, SchemaInfo } from './databases.js';

const columns: Column[] = ['_index', '_id', '_score', '_source', 'fields', 'highlight', 'sort'].map(name => ({ name, type: name === '_score' ? 'number' : name === '_index' || name === '_id' ? 'string' : 'json' }));
function cell(value: any, maxCell = Infinity): unknown {
  const v = value == null ? null : typeof value === 'object' ? JSON.stringify(value) : value;
  return typeof v === 'string' && v.length > maxCell ? `${v.slice(0, maxCell)}…` : v;
}
const row = (hit: any, maxCell?: number) => columns.map(c => cell(hit[c.name], maxCell));
const canExportAll = (body: Record<string, any>) => !(body.from || body.search_after || body.collapse || body.pit || body.aggs || body.aggregations || body.suggest);
export function elasticQuery(sql: string, fallback = '*'): { index: string; body: Record<string, any> } {
  let value: any;
  try { value = JSON.parse(sql); } catch { throw new Error('Use a JSON search body, for example {"index":"books","query":{"match_all":{}}}'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('The search must be a JSON object');
  const { index = fallback || '*', ...body } = value;
  if (typeof index !== 'string' || !/^[\p{L}\p{N}_.*,\-]+$/u.test(index) || index === '.' || index === '..') throw new Error('Invalid index name or pattern');
  for (const key of ['size', 'from']) if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 0)) throw new Error(`${key} must be a non-negative integer`);
  return { index, body };
}

function request(c: DbConnection, path: string, method: string, body: unknown, signal: AbortSignal): Promise<any> {
  // Hosts are plain names/IPs. URI credentials, paths and redirects are never accepted.
  if (!c.host || /[\s/?#@]/.test(c.host) || c.host.includes('://')) throw new Error('Use a hostname or IP and a separate port');
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = (c.ssl === 'disable' ? http : https)({ hostname: c.host, port: c.port || 9200, path, method, signal,
      ...(c.ssl !== 'disable' && { rejectUnauthorized: c.ssl !== 'require', ...tlsServer(c.tunneledFrom || c.host) }),
      headers: { accept: 'application/json', ...(data && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
        ...(c.user || c.password ? { authorization: `Basic ${Buffer.from(`${c.user}:${c.password}`).toString('base64')}` } : {}) },
    }, res => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024 * 1024) { res.destroy(new Error('Elasticsearch response exceeds 64 MB; reduce size or _source fields')); } else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if ((res.statusCode ?? 500) >= 300 || result.error) throw new Error(`Elasticsearch: ${result.error?.reason || result.error?.type || res.statusCode}`);
          resolve(result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject); req.end(data);
  });
}
const deadline = (o: { timeoutMs: number; signal?: AbortSignal }) => AbortSignal.any([AbortSignal.timeout(o.timeoutMs), ...(o.signal ? [o.signal] : [])]);
function complete(r: any) {
  if (r.terminated_early) throw new Error('Elasticsearch search terminated early; results and aggregations may be incomplete');
  if (r.timed_out) throw new Error('Elasticsearch search timed out; results may be incomplete');
  if (r._shards?.failed) throw new Error('Elasticsearch search has failed shards; results may be incomplete');
}
export async function elasticRun(c: DbConnection, sql: string, o: RunOpts): Promise<QueryResult[]> {
  const { index, body } = elasticQuery(sql, c.database); const start = Date.now();
  if ((body.from ?? 0) >= 10_000) throw new Error('Use size/from within 10,000 for preview; download truncated results for all documents');
  const wanted = Math.min(body.size ?? o.limit, o.limit, Math.max(1, 9999 - (body.from ?? 0)));
  // One extra hit distinguishes a clipped result from an exact page. Explicit size remains a query limit.
  const size = Math.min(wanted + (body.size === undefined || body.size > wanted ? 1 : 0), 10_000 - (body.from ?? 0));
  if (size < 0) throw new Error('Use size/from within 10,000 for preview; download truncated results for all documents');
  const r = await request(c, `/${encodeURIComponent(index)}/_search`, 'POST', { ...body, size }, deadline(o)); complete(r);
  const hits = r.hits?.hits ?? [];
  const total = typeof r.hits?.total === 'number' ? r.hits.total : r.hits?.total?.value;
  const results: QueryResult[] = [{ sql, columns, rows: hits.slice(0, wanted).map((hit: any) => row(hit, o.maxCell)), affected: null,
    canExportAll: canExportAll(body), truncated: hits.length > wanted || ((body.size ?? Infinity) > wanted && size === wanted && hits.length === wanted && (total === undefined || total > (body.from ?? 0) + wanted)), ms: Date.now() - start,
    note: `Index: ${index}${r.hits?.total !== undefined ? ` · Matches: ${typeof r.hits.total === 'number' ? r.hits.total : r.hits.total.value}${r.hits.total?.relation === 'gte' ? '+' : ''}` : ''}` }];
  if (r.aggregations || r.suggest) results.push({ sql, columns: [{ name: 'aggregations / suggestions', type: 'json' }], rows: [[cell({ ...(r.aggregations && { aggregations: r.aggregations }), ...(r.suggest && { suggest: r.suggest }) }, o.maxCell)]], affected: null, truncated: false, ms: Date.now() - start });
  return results;
}
export async function elasticStream(c: DbConnection, sql: string, o: Omit<RunOpts, 'readOnly' | 'limit'>, sink: RowSink): Promise<void> {
  const { index, body } = elasticQuery(sql, c.database);
  if (!canExportAll(body)) throw new Error('Download all supports document searches without from, search_after, collapse, pit or aggregations; download the displayed result instead');
  const signal = deadline(o); let scroll: string | undefined; let remaining = body.size ?? Infinity;
  try {
    let r = await request(c, `/${encodeURIComponent(index)}/_search?scroll=1m`, 'POST', { ...body, size: Math.min(2000, remaining) }, signal);
    scroll = r._scroll_id; complete(r); await sink.columns(columns);
    while (remaining > 0) {
      const hits = (r.hits?.hits ?? []).slice(0, remaining); if (!hits.length) break;
      remaining -= hits.length;
      if (!await sink.rows(hits.map((hit: any) => row(hit, o.maxCell))) || remaining <= 0) break;
      if (!scroll) throw new Error('Elasticsearch did not return a scroll cursor');
      r = await request(c, '/_search/scroll', 'POST', { scroll: '1m', scroll_id: scroll }, signal);
      scroll = r._scroll_id || scroll; complete(r);
    }
  } finally {
    if (scroll) await request(c, '/_search/scroll', 'DELETE', { scroll_id: [scroll] }, AbortSignal.timeout(5000)).catch(() => {});
  }
}
export async function elasticTest(c: DbConnection) {
  const r = await request(c, '/', 'GET', undefined, AbortSignal.timeout(15_000));
  return { version: `Elasticsearch ${r.version?.number ?? 'unknown'}`, warnings: [] as string[] };
}
export async function elasticSchema(c: DbConnection, timeoutMs: number): Promise<SchemaInfo> {
  const { index } = elasticQuery('{}', c.database);
  const r = await request(c, `/${encodeURIComponent(index)}/_mapping`, 'GET', undefined, AbortSignal.timeout(timeoutMs));
  return { schemas: [{ name: 'indices', loaded: true, tables: Object.entries(r).map(([name, value]: [string, any]) => {
    const fields: SchemaColumn[] = [];
    const walk = (props: any, prefix = '') => { for (const [key, v] of Object.entries(props ?? {}) as [string, any][]) {
      const field = prefix + key; fields.push({ name: field, type: v.type || 'object', nullable: true, pk: false });
      walk(v.properties, `${field}.`); walk(v.fields, `${field}.`);
    } };
    const mapping = value.mappings ?? {}; if (mapping.properties) walk(mapping.properties);
    else for (const m of Object.values(mapping) as any[]) walk(m?.properties);
    return { name, kind: 'table' as const, columns: fields };
  }) }] };
}
