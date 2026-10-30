"""Fictional data for README captures. Never reads runtime state or credentials."""

import difflib
import json
from datetime import datetime, timedelta, timezone

NOW = datetime(2026, 10, 31, 3, 24, tzinfo=timezone.utc)


def stamp(minutes=0):
    return (NOW - timedelta(minutes=minutes)).isoformat()


PROJECTS = [
    dict(id="shop", name="Shop API", path="/workspace/shop-api", backend="codex", sandbox="workspace-write", access="all"),
    dict(id="web", name="Storefront", path="/workspace/storefront", backend="claude", sandbox="workspace-write", access="all"),
    dict(id="ops", name="Operations", path="/workspace/operations", backend="codex", sandbox="workspace-write", access="admin"),
]


def conversation(id, project, title, minutes, status="completed", **extra):
    backend = next(p["backend"] for p in PROJECTS if p["id"] == project)
    model = "claude-sonnet-4-6" if backend == "claude" else "gpt-6.1"
    return dict(id=id, project_id=project, title=title, status=status, backend=backend,
                model=model, effective_model=model, effort="medium", last_at=stamp(minutes),
                created_at=stamp(120), draft="", **extra)


CHATS = [
    conversation("pagination", "shop", "Add cursor pagination", 2, worktree=True, branch="feat/cursor-pagination"),
    conversation("checkout", "shop", "Review checkout validation", 18),
    conversation("search", "web", "Improve product search", 4, "running"),
    conversation("a11y", "web", "Check keyboard navigation", 8),
    conversation("deploy", "ops", "Deploy the staging release", 12),
    conversation("logs", "ops", "Summarize application logs", 95),
]

SOURCE = '''import { z } from 'zod';
import { db } from '../database.js';
import type { FastifyInstance } from 'fastify';

const querySchema = z.object({
  category: z.string().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function productRoutes(app: FastifyInstance) {
  app.get('/products', async (request) => {
    const { category, cursor, limit } = querySchema.parse(request.query);

    const products = await db.product.findMany({
      where: { category },
      orderBy: { id: 'asc' },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });

    const hasMore = products.length > limit;
    const items = products.slice(0, limit);

    return {
      items,
      nextCursor: hasMore ? items.at(-1)!.id : null,
    };
  });
}
'''
BEFORE = SOURCE.replace("  cursor: z.string().uuid().optional(),\n", "").replace(
    "{ category, cursor, limit }", "{ category, limit }").replace(
    "take: limit + 1,\n      ...(cursor && { cursor: { id: cursor }, skip: 1 }),", "take: limit,").replace(
    "    const hasMore = products.length > limit;\n    const items = products.slice(0, limit);\n\n    return {\n      items,\n      nextCursor: hasMore ? items.at(-1)!.id : null,\n    };", "    return { items: products };")
# The panel API sends hunks without git's file headers.
DIFF = "".join(list(difflib.unified_diff(BEFORE.splitlines(True), SOURCE.splitlines(True), n=2))[2:])
TEST = '''import { describe, expect, it } from 'vitest';
import { buildApp, seedProducts } from './helpers.js';

describe('GET /products', () => {
  it('returns the next cursor without repeating products', async () => {
    const app = await buildApp();
    await seedProducts(app, 25);
    const first = await app.inject('/products?limit=20');
    const { items, nextCursor } = first.json();
    expect(items).toHaveLength(20);
    const next = await app.inject(`/products?cursor=${nextCursor}`);
    expect(next.json().items).toHaveLength(5);
    expect(next.json().nextCursor).toBeNull();
  });
});
'''
FILES = {"src/routes/products.ts": SOURCE, "test/products.test.ts": TEST,
         "README.md": "# Shop API\n\nA sample product catalogue.\n",
         "package.json": '{"name":"shop-api","type":"module"}\n',
         "src/database.ts": "export { db } from './client.js';\n",
         "src/routes/health.ts": "export const health = () => ({ status: 'ok' });\n"}
DIFFS = {"src/routes/products.ts": DIFF,
         "test/products.test.ts": "".join("+" + line for line in TEST.splitlines(True))}
GIT = dict(repo=True, branch="feat/cursor-pagination", hasRemote=True, ahead=0, behind=0,
           files=[dict(path=p, status=" M" if i == 0 else "??") for i, p in enumerate(DIFFS)],
           head=dict(hash="8f3a2c1", subject="feat: add product category filters", pushed=True))
CREDENTIALS = dict(author=dict(name="Rani Demo", email="rani@example.com", scope="local"),
                   transport="https", remote=dict(name="origin", url="https://example.com/demo/shop-api.git"),
                   https=dict(scheme="https", host="example.com", helper="manager", helperKind="manager"))


def event(type, data, seconds):
    return dict(id=seconds + 1, type=type, data=data,
                timestamp=(NOW - timedelta(minutes=4) + timedelta(seconds=seconds)).isoformat())


EVENTS = [
    event("user.prompt", dict(text="Add cursor pagination to GET /products. Keep the category filter and cover the edge cases.", author="Rani"), 0),
    event("turn.started", {}, 1),
    event("item.completed", dict(item=dict(type="command_execution", command="npm test -- products", aggregated_output="12 tests passed", exit_code=0)), 50),
    event("item.completed", dict(item=dict(type="file_change", changes=[dict(path=p, kind="update" if i == 0 else "add", diff=d) for i, (p, d) in enumerate(DIFFS.items())])), 64),
    event("item.completed", dict(item=dict(type="command_execution", command="npm run typecheck && npm test", aggregated_output="Type check passed. 48 tests passed.", exit_code=0)), 85),
    event("item.completed", dict(item=dict(type="agent_message", text="Cursor pagination is ready.\n\n- `GET /products` accepts `cursor` and `limit` while keeping the category filter.\n- Responses include `nextCursor`; the final page returns `null`.\n- Added coverage for empty results, invalid cursors, and page boundaries.\n\n**Validation:** type check and 48 tests passed.\n\nThe changes are ready for review.")), 100),
    event("turn.completed", dict(usage=dict(input_tokens=18420, output_tokens=1260)), 102),
    event("review.started", dict(round=1, files=len(DIFFS)), 103),
    event("review.passed", dict(round=1), 118),
]

QUERY = '''SELECT
    category,
    COUNT(*) AS products,
    ROUND(AVG(price), 2) AS average_price,
    SUM(stock) AS units_available
FROM products
WHERE active = true
GROUP BY category
ORDER BY products DESC;
'''
CONNECTION = dict(id="catalogue", label="Shop demo", driver="postgres", host="db.example.com", port=5432,
                  database="shop_demo", username="demo_reader", agent="approve", access="all", readOnly=True)
SCHEMA = dict(schemas=[dict(name="public", loaded=True, tables=[
    dict(name=name, type="table", columns=[dict(name=n, type=t, nullable=False, primary=n == "id") for n, t in cols])
    for name, cols in [
        ("products", [("id", "uuid"), ("name", "text"), ("category", "text"), ("price", "numeric"), ("stock", "integer"), ("active", "boolean")]),
        ("categories", [("id", "uuid"), ("name", "text")]),
        ("orders", [("id", "uuid"), ("total", "numeric"), ("created_at", "timestamp")]),
        ("order_items", [("id", "uuid"), ("quantity", "integer")]),
    ]
])])
RESULT = dict(readOnly=True, results=[dict(sql=QUERY, columns=[dict(name=n, type=t) for n, t in [
    ("category", "text"), ("products", "int8"), ("average_price", "numeric"), ("units_available", "int8")]],
    rows=[["Home & living", 148, "42.80", 2340], ["Accessories", 96, "24.50", 1850],
          ["Clothing", 84, "58.90", 1240], ["Books", 67, "18.25", 960], ["Outdoor", 52, "76.40", 780],
          ["Stationery", 38, "9.75", 1540]], ms=12, truncated=False)])


def preferences(theme="dark"):
    return {
        "dalang-theme": theme, "dalang-palette": "iris", "dalang-group-by": '"status"',
        "dalang-inspector": "true", "dalang-inspector-width": "390",
        "dalang-seen": json.dumps({c["id"]: stamp(60) if c["id"] == "a11y" else c["last_at"] for c in CHATS}),
        "dalang-code-term": "false",
        "dalang-code-tabs:pagination": json.dumps(dict(tabs=["src/routes/products.ts", "test/products.test.ts"], active="src/routes/products.ts")),
        "dalang-sql-open": json.dumps(["c:catalogue", "s:catalogue::public", "t:catalogue::public:products"]),
        "dalang-sql-consoles:demo": json.dumps(dict(active="summary", consoles=[dict(id="summary", connId="catalogue", database="", schema="public", title="Catalogue overview", text=QUERY)])),
    }


def response(path, query, method):
    """Return only explicitly supported fixture responses; reject everything else."""
    if method == "POST" and path == "/api/db/connections/catalogue/query":
        return RESULT
    if method == "POST" and path.endswith("/fs/stat"):
        return dict(files=[dict(path=p, mtime=1, size=len(t)) for p, t in FILES.items()])
    if method != "GET":
        raise KeyError(f"Unexpected mutation: {method} {path}")
    fixed = {
        "/api/auth/status": dict(bypass=True), "/api/me": dict(id="demo", name="Rani", role="admin"),
        "/api/projects": PROJECTS, "/api/schedules": [], "/api/approvals": [],
        "/api/db/approvals": [], "/api/code-memory/requests": [],
        "/api/ssh/approvals": [dict(id="approval-demo", conv="deploy")],
        "/api/db/connections": [CONNECTION], "/api/db/workspaces": [dict(id="demo", name="Shop workspace", conns=["catalogue"])],
        "/api/db/connections/catalogue/schema": SCHEMA,
        "/api/settings/default-model": dict(model="gpt-6.1"), "/api/settings/default-effort": dict(effort="medium"),
        "/api/models": [dict(slug="gpt-6.1", name="GPT-6.1", efforts=["low", "medium", "high"])],
    }
    if path in fixed:
        return fixed[path]
    if path == "/api/accounts":
        return [dict(name="demo-claude" if query.get("backend") == ["claude"] else "demo-codex", enabled=True, loggedIn=True,
                     limits=dict(windows=[dict(usedPercent=24 if query else 38, resetsAt=NOW.timestamp() + 7200)]))]
    for project in PROJECTS:
        base = f'/api/projects/{project["id"]}'
        if path == base + "/conversations":
            return [c for c in CHATS if c["project_id"] == project["id"]]
        if path == base + "/code-memory":
            return dict(enabled=True, changed=False, direct=True, index=dict(status="ready", graph=True, indexedAt=stamp(3)))
    base = "/api/conversations/pagination"
    if path == base:
        return CHATS[0]
    suffix = path.removeprefix(base)
    if path.startswith(base):
        if suffix == "/queue" or suffix == "/terminals":
            return []
        if suffix == "/history":
            return dict(events=EVENTS, before=None, more=False, last=EVENTS[-1]["id"])
        if suffix == "/git":
            return GIT
        if suffix == "/git/credentials":
            return CREDENTIALS
        if suffix == "/git/diff":
            return dict(diff=DIFFS[query["path"][0]])
        if suffix == "/code":
            return dict(conv=CHATS[0], project=PROJECTS[0], root="shop-api", cwd="/workspace/shop-api", readOnly=False, busy=False, terminal=True)
        if suffix == "/fs/file":
            content = FILES[query["path"][0]]
            return dict(content=content, mtime=1, size=len(content))
        if suffix == "/fs/list":
            directory = query.get("path", [""])[0]
            prefix = directory + "/" if directory else ""
            children = {}
            for file in FILES:
                if file.startswith(prefix):
                    tail = file[len(prefix):]
                    name = tail.split("/")[0]
                    children[name] = dict(name=name, dir="/" in tail)
            return dict(entries=sorted(children.values(), key=lambda e: (not e["dir"], e["name"])))
    raise KeyError(f"Missing fixture: {method} {path}")
