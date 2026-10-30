# APIs and integrations

Connect agents and external services. Server credentials and access controls are covered in [Setup](setup.md);
the [design guide](design.md) explains execution and trust boundaries.

- [HTTP API](#use-without-the-panel) and [MCP / sub-agents](#mcp)
- [ClickUp](#clickup) and [external MCP servers](#other-mcp-servers)
- [SQL editor and database permissions](#sql-editor)
- [MongoDB and Redis](#mongodb-and-redis-in-the-sql-editor)
- [Database SSH tunnels](#databases-behind-an-ssh-server), [SSH hosts](#ssh-hosts-for-agents)

## Use without the panel

All routes need `Authorization: Bearer $LZVR_TOKEN`.

```bash
bash scripts/smoke.sh        # create a project + chat, send a prompt, stream the events (real Codex)
```

REST: `/api/projects`, `/api/projects/:id/conversations` (body `{"worktree": true}` for an own worktree),
`/api/conversations/:id/{prompts,queue,cancel,draft,events}`, `/api/conversations/:id/git` and `.../git/{diff,message,mr-description,commit,revert,discard,pull,branches,branch,branch/delete,pull-request}`,
`/api/search?q=`, `/api/conversations/:id/schedules`, `/api/schedules` (`/:id`, `/:id/run`, `/preview?cron=`),
`/api/accounts`, `/api/approvals`, `/api/uploads`, `/api/push/*`.
Design notes and diagrams: [Architecture and execution flow](design.md).

## MCP

Point an MCP client at `https://<host>/mcp` with the bearer token (Streamable HTTP, stateless). Tools: `list_projects`,
`create_project`, `delete_project`, `list_conversations`, `create_conversation`, `get_conversation`,
`send_prompt`, `list_queue`, `remove_queue_item`, `cancel_turn`, `set_draft`, `get_events`, `list_accounts`,
`unblock_accounts`, `get_approval`, `list_models`, `set_model`, and the project memory's `memory_search`, `memory_save`,
`memory_update`, `memory_forget` (see [Project memory](design.md#project-memory)).

**Two kinds of caller.** An outside client using the main token gets the available administrative and everyday tools. An agent running inside a chat
(with `MCP_INJECT=1`, each turn gets its own short-lived token bound to that chat, set up through
`-c mcp_servers.dalang.url=... -c mcp_servers.dalang.bearer_token_env_var=LZVR_MCP_TOKEN`, plus
`default_tools_approval_mode="approve"` since `codex exec` cannot ask before an MCP call; Claude Code gets
`--mcp-config` and `--allowedTools=mcp__dalang` for the same reason) gets only
`list_projects`, `list_conversations`, `create_conversation`, `get_conversation`, `send_prompt`, `list_queue`,
`get_events`, `list_accounts`, `get_approval`, `list_models`, `set_model` and the four `memory_*` tools. Its token works only on `/mcp`, dies when the turn ends, and the chat
it claims to be comes from the token, not from anything it sends. A `send_prompt` from an agent into a *different*
chat is held until you approve it in the panel (or `POST /api/approvals/:id/approve`).

**Sub-agents and their models.** `create_conversation` takes `model`, `effort` and `backend`; `set_model` changes a
chat's model or effort from its next turn on (its session carries on). `get_conversation` says what the chat runs with
(`effective_model`, `effective_effort`: its own, else the panel's default; `null` leaves it to the CLI), and
`list_models` lists the choices. An outside client may pick anything. An agent may pick only what an admin allows in
**Settings → Model & effort** (*agents may pick*, per backend): a list of models, weakest first, and the highest
effort. Until that is set, agents keep the default. An agent may change only its own chat and the chats it created
(`parent` in the conversation), and the tools tell it to start with the weakest model that fits and go one step up
only when a result falls short.

**Sub-agents.** When delegation is requested or enabled by the orchestrator mode below:
`create_conversation` from inside a chat makes a sub-agent of it (with `prompt`, its first task starts at once;
with `worktree`, it gets its own branch and folder). In the sidebar each sub-agent sits under the chat that started it,
with its model, and folds away like a project. A prompt an agent sends its own sub-agent in the same project runs
without approval, and when the sub-agent is done (with everything its parent queued) its last answer comes back to the
parent as a new prompt, so the parent goes on without polling. A sub-agent that handed work to sub-agents of its own
holds its report until they have all answered, and the turn that reads their last answer reports up instead, so a
parent gets no "finished" while work below it still runs. Prompts someone else sends a sub-agent are not reported. **Settings → Model & effort → Orchestrator** sets how many
sub-agents one chat may have (default 5, 0 turns them off), how many levels deep (default 2), and whether agents may
send their own sub-agents work without approval (default on).

**Orchestrator mode.** By default (*Only when asked*) an agent starts sub-agents when someone tells it to: the tools
are there, but nothing points it at them. With *Agents decide themselves*, every turn that may still start a sub-agent
(gateway on, sub-agents allowed, chat above the depth limit) gets a guide on when and how to (split independent,
sizeable parts; the weakest model that fits; a worktree for one that changes files; no polling; check the reports),
followed by its project id, how many sub-agents it may still start and the models it may pick. Claude Code gets it with
`--append-system-prompt`, Codex as `developer_instructions`. The guide can be edited there (empty = the built-in one).
This mode can use noticeably more of the accounts' limits.

**What this does and does not protect.** It stops an agent from messaging other chats or widening sandboxes through the gateway.
It is not a wall against a hostile agent on the same machine: an agent that
can read files and runs as root can still read `/etc/systemd/system/lzvr-dalang.service` (which holds the main token)
or the database. The gateway removes its own `LZVR_*` variables from the environment of every Codex process, but
keep secrets out of what Codex can read if that matters to you. Agents can also read other chats' events via `get_events`.

## ClickUp

Set up in the panel: **Settings → MCP**, tab **ClickUp** (shown to the owner only). Paste a personal API token (ClickUp → Settings
→ Apps → API Token) and Save; **Test connection** shows which ClickUp user it reads as and the workspaces it can see.
One token reads every workspace that ClickUp user is in (a workspace under another ClickUp login needs that login's
token, which is not supported). Optional: a default workspace ID (default: all of them; a chat can still ask for
particular ones) and the time zone message times are given in (default your ClickUp profile's). The token is stored
in the database and never sent back to the panel, only its last four characters. **Remove token** turns the tools off.

Once a token is saved, `/mcp` has three more read-only tools:

- `clickup_whoami`: the ClickUp user it reads as, its workspaces (and the default) and the time zone.
- `clickup_list_channels`: chat channels, DMs and group DMs (optionally only those with messages since a date), with
  their workspace. DMs are named after who they are with (`DM with sari`).
- `clickup_chat_history`: messages between two dates (at most 93 days per call), oldest first, each with local date,
  time, weekday, workspace, channel (DMs and group DMs included) and author. Options: `workspace_ids`, `mine_only`
  (default: only your own messages), `channel_ids`, `include_replies` (thread replies; one more request per thread) and `limit`.

The tools only return messages; what to make of them is up to the prompt. For example: *"cek chat ClickUp gue bulan
September, jam kerja gue 09:00-18:00, kapan aja gue lembur (di luar jam kerja atau weekend) dan ngerjain apa?"* The agent
reads the month's messages and works out the late days and the work from their times and content. Work you did not
chat about does not show.

**Only the owner gets them**, since they read with the owner's ClickUp token: the main token or the owner's own email
sign-in from outside, and inside a chat only during a turn the owner sent (prompts from other panel users, agents,
approvals or their schedules do not get them), and Settings → MCP is refused to everyone else, admins included.
Ticking **All users** gives them to every user's sign-in and every turn too, still reading as the owner's ClickUp user.
The agent in the chat needs `MCP_INJECT=1` to reach `/mcp` at all. Like the main token, the ClickUp token sits where an
agent that reads files as root could find it (the database), so the "What this does and does not protect" note above
applies to it too. One call makes at most 250 ClickUp requests (ClickUp allows about 100 a minute on most plans); a busy workspace over a long
range may stop early with a warning, so ask for a shorter range or particular channels.

## Other MCP servers

**Settings → MCP** (the owner only) has a tab for ClickUp, one for every other MCP server the agents get next to this
gateway's own (for Codex and Claude Code alike), and **Add**: an HTTP server (URL and an optional bearer token) or a
command started over stdio (command, arguments, environment). **Add** offers Context7, Playwright and Sentry
filled in; every field can be changed. In a server's tab a switch turns it off without forgetting it.

- **Who gets them**: a turn the owner sent gets every server that is on. Any other turn (an admin's or dev's prompt or
  schedule, a prompt from another agent, an approval) gets only the servers marked **All users**, with the owner's
  credentials for that server. Unmarked, they never see it.
- **How**: Codex gets `-c mcp_servers.<name>.…` options, Claude Code `--mcp-config` and `--allowedTools=mcp__<name>`.
  A headless run cannot ask before a tool call, so the servers' tools are approved up front, in `read-only` projects
  too: only add servers whose tools you trust there (a browser, an API with a token scoped to reading).
- **Secrets** never go on a command line or back to the panel: the CLI reads the bearer token from
  `LZVR_MCPS_<NAME>_TOKEN` and a stdio server's environment from variables of the same name in the turn's environment.
  An agent's own commands may see that environment too, and the values sit in the database like the ClickUp token,
  so give servers tokens with the least rights they need.
- A server is started by the CLI on every turn that gets it (`npx` downloads the package the first time), and a
  stdio command runs on this machine as the user Dalang runs as. These servers need no `MCP_INJECT`.

**Verify on your versions.** The injected config was run against Codex CLI 0.162.1 (`read-only`: MCP calls work,
writes stay blocked) and Claude Code 2.1.299. An older Codex may not know `default_tools_approval_mode`, and then
refuses every MCP call ("requires approval"). With `MCP_INJECT=1`, start one chat and ask it to list its MCP tools;
if it cannot use them, update the CLI, or unset `MCP_INJECT` (everything else keeps working).

## SQL editor

**SQL Editor** in the sidebar (or the command palette) opens `/sql` in a tab of its own. It is not tied to a chat: the
connections belong to the panel.

- **Workspaces**: the picker next to "SQL Editor" switches between named sets of connections ("Production",
  "Shop Dev", ...), each with its own consoles (kept in the browser) and query history; `/sql#w=<id>` opens one
  directly. Admins add, rename and delete them and choose their connections (`⋯` beside the picker); a connection can
  be in several, a new one goes into the workspace it was added in, and the first time every connection is in one
  named Default. Workspaces only group: who may open a connection is still set on the connection.

- **Connections** (admins add, change and remove them; the `+` above the tree): PostgreSQL (and what speaks its
  protocol: Supabase, Neon, CockroachDB, ...), MySQL, MariaDB, MongoDB, Redis, or a SQLite file on this machine (a file
  in `STATE_DIR` is allowed only for an owner-only connection). **Test connection** tries the form before saving and warns about a user whose rights reach past the
  tables (a PostgreSQL superuser or a member of `pg_read_server_files` and the like, MySQL `ALL PRIVILEGES`, `FILE` or
  `SUPER` on `*.*`): read-only does not take those away. Passwords never go back to the panel; like the
  other secrets they sit in Dalang's database. **Who may open it** works like a project's access: everyone, owner and
  admins, or the owner only. **Read-only for everyone** makes the database refuse every write, from the panel too.
- **Other databases on a PostgreSQL server**: a PostgreSQL connection is bound to one database, so by default the
  connection opens only the one it names. **Show every database on the server** lists every database its user may
  connect to (`pg_database`) under the connection, each opened through its own connection. Each console picks its
  database next to its connection, and agents pass `database` to `db_schema` and `db_query`; access and agent access
  cover every database listed.
  MySQL and MariaDB need none of this: leave **Database** empty and every database shows as a schema.
- **Querying**: the tree lists schemas, tables and views with their columns (double-click a table for its first rows;
  its `⋯` menu, or a right click on it, also shows its **DDL** in a new console, asks the agent about it, or copies its
  name or a SELECT; connections, databases and schemas have such a menu too). **Find a database or table** above the
  tree lists every connection, database, schema and table of the workspace with that in its name (from the table
  lists read so far; a server's databases not opened yet can be read from there); a click shows it in the tree. A big database (over 400 tables) lists every table at once but
  reads the columns schema by schema, when one is opened or a query needs them (the table list stops at 100 000).
  What was read (tables, the columns read so far, a server's databases) is kept in the browser (IndexedDB) and shown
  at once on the next visit, with "read 3h ago" beside it; it is read again on **Refresh** (the connection's `⋯`),
  after a statement that changes tables (`CREATE`, `ALTER`, `DROP`, ...), when the connection is edited, and by itself
  in the background once it is a week old.
  Each console tab has its connection, and beside it the database unqualified names are in: on MySQL/MariaDB a
  database of the server (what `USE` picks; "No database" means writing `db.table`), on PostgreSQL a schema, put first
  in `search_path`. That picker is typed in to find one (↑ ↓ and Enter pick, Esc closes). `Ctrl Enter` runs the
  selection or the statement at the cursor, `Ctrl Shift Enter` the whole console, statement by statement, stopping at
  the first error (the results before it stay). A statement returns at most the row limit (100, 500, 1000 or All, which is at most
  100 000; the rest is never fetched) and stops after two minutes; **Cancel** stops it sooner (PostgreSQL `pg_cancel_backend`, MySQL/MariaDB
  `KILL QUERY`; SQLite runs to the end). `Shift Alt F` formats the selection or the console (sql-formatter). **History**
  lists the last 300 runs of this browser, to insert or run again. Results stay in tabs below the console: a query
  on another table adds a tab, one on the same table (or the same query again) refreshes its tab, and statements
  that return no rows share an **Output** tab (at most 12 tabs; the oldest go). The maximize button (or
  `Ctrl Shift '`) shows only the results, full screen (the browser's own full screen where it allows it); `Esc`
  brings the rest back. A result's rows copy (those it holds) or download (all of them) as CSV (with a BOM, so
  Excel reads UTF-8), TSV, Excel (`.xlsx`, header bold and frozen), JSON, JSON Lines, SQL `INSERT` statements (for the
  result's table, in the connection's dialect), a Markdown or an HTML table; the download asks for a file name
  (the tab's and the time, to change). A result cut at the row limit downloads as DataGrip's export does: the server
  runs its statement again, read-only, and writes the file as it reads (a batch at a time, never the whole result in
  memory), with no row limit and for up to 30 minutes; the browser saves it as it comes, and cancelling the download
  there cancels the statement. Excel stops at its last row (1 048 576); MongoDB and Redis results are read whole
  first, up to 1 000 000 rows. Consoles are kept in the browser. Every run opens its own connection, so a
  transaction lasts one run: `BEGIN; ...; COMMIT;` in one go.
- **Every row at once**: an `UPDATE` or `DELETE` without a `WHERE` of its own (one in a string, a comment or a
  subquery does not count), and `TRUNCATE`, does not run straight away. The server holds the whole script and the
  panel asks first, naming each such statement and how many rows its table has now; **Run anyway** runs it. Agents
  are refused such a statement on a **Read and write** connection (`WHERE true` says every row is meant), and on
  **Write with approval** its card says so in red. It reads the SQL as written: a function or a `DO` block that does
  the same is not caught.
- **The result grid**: a click on a cell shows its whole value beside the grid (JSON laid out); a click on a column
  header sorts. A result that is a table's own rows (`SELECT * FROM <table>`, with its WHERE, ORDER BY and LIMIT, of a
  table with a primary key) gets a **WHERE** filter and sorts on the server, and unless the connection is read-only it
  can be edited: change cells (or **Set NULL**), **Add row**, **Delete row**, then **Submit**. **SQL** shows the
  statements the changes make as you edit, and **Submit** shows them once more before **Run**; the server writes them
  (the same code that runs them, values written in as literals for reading). The changes go to the database in one
  transaction, each row found by its primary key with the values as parameters; a row that changed or went meanwhile
  undoes them all. The footer shows the query that read the rows (with the filter and sort order).
- **Ask the agent**: from a result (its query and error, or its first 20 rows) or a table's `⋯` menu (its columns),
  the question goes to a chat of your choice, or a new one in a project, with the connection, the query and the
  tables involved attached, and opens it in the panel. The agent is told whether it may query the connection itself.
- **Agent access** per connection: **Off** (the default), **Read-only**, **Write with approval** or **Read and
  write**. With approval, agents read freely; a script the database refuses as a write (it runs read-only first, so
  nothing of it is kept) waits in **Approvals** (sidebar count, push notification, a card in the agent's chat). An
  admin who may open the connection runs it as written (**Approve and run**) or rejects it, and either way the outcome
  is queued into the agent's chat as a message; the agent can also ask `db_approval`. A connection that is not off is
  given to agents through this gateway's MCP (`db_list_connections`, `db_schema`, `db_query`), so chats
  need `MCP_INJECT=1`. An agent only sees connections the user whose prompt it runs may open (with nobody behind it:
  the "everyone" ones). Every MCP caller counts as an agent here, an outside client with a token too. The last 200
  agent queries per connection are logged (**Agent queries** in its `⋯` menu, admins). While any connection is not
  off, every chat turn is also told to reach databases only through these tools (start with `db_list_connections`),
  not with `psql`, `mysql`, `mongosh`, `redis-cli`, a script or credentials from `.env`, unless the person asks for that
  explicitly, and to say so when a database is not listed or is read-only instead of working around it (Claude Code:
  `--append-system-prompt`, Codex: `developer_instructions`).
- **Approval target and recovery**: a database approval records its original connection target. If that target changes,
  or an old approval has no target record, reject it and request a fresh approval. Before dispatch, its status is saved
  as `executing`. After an interrupted execution it becomes `unknown`, remains visible, and cannot run again. Check
  the database and any backup to establish what happened before asking for another write. An admin can **Dismiss**
  an `unknown` request to remove it from the active list. Its status becomes `dismissed`, with the original outcome
  retained in the recent approval history; dismissal neither runs the write nor confirms success or failure.
- **Backups before an agent's write**: before an agent's write runs (on **Read and write**, or when an admin approves
  it), Dalang reads the rows its `UPDATE`, `DELETE`, `TRUNCATE` and `DROP TABLE` statements are about to change (the
  same `WHERE`, joins and `WITH`; MongoDB: the documents its updates, deletes and drops match, only the one picked for
  `updateOne`, `deleteOne`, `findOneAnd...` and the like) and keeps them as JSON in
  `STATE_DIR/db-backups/<connection>/` (the newest 200 per connection). Admins find them under **Backups** in the connection's `⋯` menu (when, who, which chat, the SQL, how many rows of which tables; **download** gives the file), and an agent query that took one has a **backup** link in its log. If that read
  fails, or the write would change more than 50 000 rows, nothing runs (`DROP TABLE IF EXISTS` of a table that is not
  there goes ahead; any other failed read stops it). Inserts change nothing that was there and are not backed up.
  Upserts (`ON CONFLICT DO UPDATE`, `ON DUPLICATE KEY UPDATE`, `INSERT OR REPLACE`), `MERGE`, `REPLACE`,
  `ALTER ... DROP`, a PostgreSQL `WITH` whose queries write, MongoDB `bulkWrite` / `$out` / `$merge` and Redis
  writes cannot be read beforehand: they run, and the agent and the approval outcome say they were not backed up.
- **How read-only holds**: the database enforces it, the SQL is never inspected. PostgreSQL runs each statement in a
  `READ ONLY` transaction that is rolled back, MySQL/MariaDB in a session set to `TRANSACTION READ ONLY` (DDL is
  refused there too), SQLite opens the file read-only; each statement gets a fresh connection, so one cannot loosen
  the next. This keeps an agent from writing *through these tools*. An agent with a shell can still reach a database
  whose address and credentials it finds (a `.env` in its project, say), so for a strict limit give the connection a
  database user that may only read.
- **What agents are refused in every mode**: statements that reach past the tables, which read-only alone does not
  stop: `COPY`, `INTO OUTFILE`/`DUMPFILE`, `VACUUM INTO`, `ATTACH`, `LOAD`, `KILL`, `ALTER SYSTEM`, `SET GLOBAL`,
  `CREATE EXTENSION`, functions such as `pg_read_file`, `lo_export`, `dblink`, `query_to_xml`, `LOAD_FILE` (and, on
  read-only connections, `DO` blocks). The list cannot be complete, which is why a user without such rights is the
  real limit (see the warning of **Test connection**).

## MongoDB and Redis in the SQL editor

Neither speaks SQL, so their consoles take their own commands, and some SQL features do not apply (editing rows in the
grid, Format, SQL `INSERT` export, DDL; MongoDB shows a collection's indexes and options instead).

- **Connecting**: host and port, or a whole URI in the host field (`mongodb+srv://...`, `rediss://...`). MongoDB's
  **Default database** and Redis's **Database number** are where a console starts; each console picks its own
  (MongoDB: any database of the server; Redis: db0 to db15).
- **MongoDB** takes mongosh-style commands: `db.users.find({ age: { $gt: 30 } }, { name: 1 }).sort({ name: 1 })`,
  `aggregate([...])`, `countDocuments`, `distinct`, `insertOne`/`insertMany`, `updateOne`/`updateMany`, `deleteOne`/
  `deleteMany`, `findOneAnd...`, index commands, `show dbs`, `show collections`, `db.getCollectionNames()`. Several in a
  console are split at `;` or at each line starting `db.`. They are **read, not run**: values are mongosh's literals
  (`ObjectId("...")`, `ISODate("...")`, `NumberLong(...)`, `/regex/i`, unquoted keys), and anything else (a variable,
  a function) is refused. Documents become rows with a column per top-level field; nested ones show as JSON (whole in
  the value panel). The tree lists databases, collections and views, with fields read from a sample of 20 documents.
- **Redis** takes its commands, one per line (`HGETALL user:1`, `SCAN 0 MATCH user:* COUNT 100`), quoted like
  redis-cli. Replies become tables (a hash's fields and values, a sorted set's members and scores, a SCAN's keys with its
  next cursor beside them, INFO's sections). The tree lists the databases that hold keys and their keys (found with
  SCAN, at most 5 000 per database), each with its type and time to live; double-click reads a key the way its type
  is read (GET, HGETALL, LRANGE, ...). SELECT is the console's database picker.
- **Read-only, the agent rules and asking first** hold for both, but Dalang decides them command by command, as neither
  has a read-only transaction: MongoDB runs only find, findOne, aggregate (without `$out`/`$merge`), the counts and
  distinct; Redis only the commands that read. Agents are also refused `$where`, `$function` and `$accumulator` (server
  JavaScript) and `dropDatabase`, and on Redis CONFIG, EVAL/FUNCTION, KEYS (use SCAN), FLUSH*, DEBUG, MODULE, ACL,
  CLIENT and the like. `deleteMany({})`, `updateMany({}, ...)`, `drop()`, FLUSHDB and FLUSHALL ask before they run.
  **Test connection** warns about a MongoDB user with roles beyond reading (or a server without users) and a Redis
  user that may run every command. A MongoDB user with the `read` role, or a Redis ACL user without write commands, is
  the real limit.

## Databases behind an SSH server

A connection (any engine but SQLite) can go through an SSH tunnel: tick **Connect through an SSH tunnel** and give the
SSH host, port (22 if empty), user, and a password or a private key (paste its text or **Load a key file**; a
passphrase if it has one). The database's host and port are then as the SSH server sees them, often `localhost`. The
host field cannot hold a URI then. A tunnel is opened for each query, tree read or test and closed after it; TLS to
the database still checks the database's own name.

The SSH server's key is trusted on first use: **Test connection** shows its fingerprint (`SHA256:...`) and **Save**
trusts it. From then on a server with another key is refused until the connection is tested and saved again (for a
reinstalled server); changing the SSH host or port forgets the trusted key. SSH passwords, keys and passphrases are
stored like the database password and never sent back to the browser.

## SSH hosts for agents

The **SSH Hosts** page (in the sidebar, admins) keeps logins to servers and VMs that agents may run shell commands on without ever
knowing the login. Each host has a name, label, address, port, user, a password or private key (and passphrase), an
optional sudo password, and a note telling agents what it is ("staging web server, the app is in /opt/app"). Like a
SQL connection it has **Who may use it** (everyone, owner and admins, owner only; it counts for the person an agent
works for) and an agent mode:

- **Off**: agents do not see it.
- **Every command after approval**: each command waits in Approvals (and as a card in the chat) until an admin runs or
  rejects it; the output goes back to the agent's chat as a message.
- **Run**: commands run at once, except those that read as dangerous, with `sudo` or without: they wait for an admin
  as above, and the card says why. That covers deleting files (`rm -r`/`-f`, `find -delete`, `xargs rm`), wiping or
  formatting disks (`mkfs`, `dd of=`, `shred`, writes to `/dev/sd*`), emptying or overwriting system files, shutdown and
  reboot, stopping or restarting services, `kill`, changing users, passwords, `sudoers`, `authorized_keys` or
  `sshd_config`, recursive `chmod`/`chown`, firewall and network changes, removing packages, containers or Kubernetes
  objects, mounting, piping into a shell or interpreter (`curl ... | sh`, `base64 -d`, `eval`), running a `.sh` file,
  `crontab -r`, dropping database tables and `git reset --hard` or force pushes. **Also hold for approval** adds the
  host's own regular expressions. This reads the command as text, so it is best effort: shell can hide a command (a
  variable, a script written in one call and run in another). For a server that matters, the real limits are a login
  user with only the rights it needs, and "Every command after approval".

Agents get it through this gateway's MCP (`MCP_INJECT=1`): `ssh_list_hosts` gives each host's name, label, note and
mode only, never its address, user or secrets; `ssh_exec` runs one command (`host`, `command`, optional `sudo` and
`timeout_seconds`, 60 s by default, at most 600) in a fresh session without a terminal or input and answers with its
exit code, stdout and stderr (the start and end of long output, 100 KB at most); `ssh_approval` tells what became of a
held command. `sudo: true` first asks whether sudo needs a password there (`sudo -n`); if not (NOPASSWD, a cached
login) the command runs through `sudo -n` and no password is sent at all. Otherwise it runs through `sudo -S -k` with
the sudo password (or the login password) written to sudo's input, and the command's own input is `/dev/null`, so the
password never reaches it; with a key login and no sudo password, sudo must not ask. When a host is removed or
pointed at another address, port or user, the commands still waiting for approval on it are rejected and their chats
told, so an Approve never runs one on a server it was not asked for. The password, passphrase, sudo password and every
line of the private key are replaced by `[secret]` in whatever a command prints, so `cat` of a file holding them does
not hand them over. While any host is open to agents, every turn is told to use these tools instead of `ssh`, `scp` or
keys of its own. Each command goes into the host's log, shown under its form.

SSH approvals also save `executing` before dispatch. After a restart interrupts execution, their status is `unknown`
and the original approval cannot run again. Check the server's actual state before requesting another command.
An admin can **Dismiss** an `unknown` request to remove it from the active list. Its status becomes `dismissed`,
with the original outcome retained in the recent approval history; dismissal neither runs the command nor confirms
success or failure.

The host's key is trusted on first use as for an SSH tunnel: **Test connection** logs in, shows the key's fingerprint
and what the host is (`uname`, the user), and **Save** trusts it. Until then, or after the key changes, agents are
refused. Changing a host's address, port or user drops its saved password, key, passphrase and sudo password (they
must be given again), so a saved login is never sent to another server; secrets never go back to the browser. A login an agent cannot see still lets it do whatever that user may on the host: give it a user with only the
rights it needs, and prefer "after approval" for servers that matter.
