# lzvr-dalang

*The puppeteer behind the screen.* lzvr-dalang (the panel calls itself Dalang) is a self-hosted control room for the **Codex CLI**: a web panel
(installable on your phone) and an HTTP/MCP API that run headless `codex exec` sessions on your own VM, with failover
between your own Codex accounts. Part of the `lzvr` toolbox (environment variables are `LZVR_*`).

- **Projects and chats**: register folders as projects; each project has parallel chats, each with its own Codex
  session, draft and prompt queue.
- **Live view**: tool activity, commands and answers stream into the panel over SSE.
- **Worktree per chat** (optional, git projects): "New chat in own worktree" in a project's `⋯` menu gives the chat a
  branch `dalang/<id>` from the project's HEAD, checked out under `<STATE_DIR>/worktrees/<chat id>`. Its agent works only
  there, so parallel chats never write over each other. Deleting the chat removes the worktree (uncommitted work there is
  lost) and the branch too, unless it has commits that were never merged.
- **Changes**: the branch button in a chat's header lists what git sees in the folder that chat works in, with each
  file's diff. Commit all or selected files, revert one file, discard everything, and for a worktree chat merge its branch
  into whatever the project folder has checked out (a conflict aborts the merge and leaves the folder as it was). These
  actions are refused while an agent is running in the same folder, and in `read-only` projects they are admin only.
  Commits use the machine's git identity, or `Dalang <dalang@localhost>` when it has none. **Generate message** asks
  the chat's own agent (same CLI and model) for a one-line Conventional Commit subject (`feat: Add ...`), given the
  selected diffs, the repo's recent commit subjects and the chat's last requests. For a worktree chat with commits to
  merge, **Generate MR description** writes a Merge Request description (`## Title`, `## Summary`, `## Changes`, ...) from
  the branch's commits and its diff against the branch it merges into. **Copy MR description** copies the Markdown for
  GitLab/GitHub, and the merge commit uses it as its message (the Title line as subject, the other sections as body;
  editable before merging, empty = git's "Merge branch ..."). Admins can change both instructions in **Generate prompts**
  (the same for Codex and Claude Code). These runs are read-only, have no tools, keep no session
  (`codex exec --ephemeral`, `claude --no-session-persistence`) and use the same account failover; they do count against
  the account's usage.
- **Account failover**: with two or more of *your own* Codex accounts, a usage limit moves the same turn to the next
  account and resumes the session.
- **Adopt a session**: bring an interactive `codex` session into the panel.
- **Passkeys + push**: passkey login on top of the access token, installable PWA, Web Push when a turn finishes,
  fails or needs input.
- **MCP gateway** at `/mcp` (17 tools) so other agents can drive chats; messages between chats can require approval.

- **Claude Code too**: a chat can run on Claude Code instead of Codex (the `CC` button next to a project's `+`). Needs the
  `claude` CLI on PATH (or `CLAUDE_BIN`). Accounts are added from the panel menu ("Claude Code accounts"), each with its own
  `CLAUDE_CONFIG_DIR`, with the same failover. Claude Code has no OS sandbox: `read-only` runs in plan mode,
  `workspace-write` allows edits and Bash unrestricted, `danger-full-access` bypasses all permission checks.

Not included: running project tests in an isolated Docker-in-Docker sandbox (dropped; see "Scope").

## Install on the VM (no Docker)

Needs Node >= 22.13 and the `codex` CLI on PATH (`npm i -g @openai/codex`).

```bash
npm ci && npm run build
openssl rand -hex 32                                   # -> LZVR_TOKEN (min 32 chars)
```

There is no `codex login` step on the VM: Codex accounts are added from the panel (see "Adding Codex accounts").

`/etc/systemd/system/lzvr-dalang.service`:

```ini
[Unit]
Description=lzvr-dalang
After=network.target

[Service]
WorkingDirectory=/opt/lzvr-dalang
ExecStart=/usr/bin/node dist/main.js
Environment=LZVR_TOKEN=<64-char token>
Environment=WORKSPACE_ROOT=/
Environment=STATE_DIR=/opt/lzvr-dalang/state
Environment=HOST=127.0.0.1
# Passkeys and the installable app need HTTPS. Set both once a TLS proxy serves the panel:
# Environment=LZVR_RP_ID=panel.example.com
# Environment=LZVR_ORIGIN=https://panel.example.com
# Environment=TRUST_PROXY=1
Restart=on-failure
User=root

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now lzvr-dalang
```

### nginx (HTTPS)

Dalang listens on `127.0.0.1:9876` only, so put nginx in front. `nginx.conf` in this repo is a ready server block on
port 80 with **no ssl**: certbot adds the https block and the redirect itself. It keeps the live event stream unbuffered,
allows 60 MB uploads, rate-limits the sign-in endpoints, and passes the real client address (replacing `X-Forwarded-For`,
so it cannot be forged). To use it:

1. Replace `panel.example.com` in the file and copy it to `/etc/nginx/conf.d/lzvr-dalang.conf`, then
   `nginx -t && systemctl reload nginx`.
2. Let certbot add TLS: `certbot --nginx -d panel.example.com`.
3. Add to the service environment and restart it: `LZVR_RP_ID=panel.example.com`,
   `LZVR_ORIGIN=https://panel.example.com`, `TRUST_PROXY=1`.

**Only certain IPs can open it.** The `geo $lzvr_allowed { ... }` block at the top of `nginx.conf` is the allowlist: list
the addresses or CIDR ranges that may reach the panel and API (yours, your office, your VPN) and everyone else gets
`403`. It ships with example addresses that match nobody, so until you edit it only the machine itself gets in. The check
sits inside the two app locations, not at server level, so certbot's validation (which comes from Let's Encrypt, any
address) and its renewals keep working. If another proxy or a CDN (Cloudflare, a load balancer) sits in front of nginx,
nginx sees that proxy's address instead of the visitor's, so you would need nginx's `realip` module before this list means
anything. For a stricter wall, also restrict ports 80/443 in the firewall (`ufw allow from <ip> to any port 443`), but keep
80 open to everyone until the certificate is issued, and again at renewal time unless you renew with the DNS challenge.

Open the panel at that URL (or `http://127.0.0.1:9876` through an SSH tunnel), enter the token, then use
**Add passkey** and **Notifications** in the header. Passkeys, push and "install app" only work over HTTPS (or localhost).

### Users and roles

The main access token (`LZVR_TOKEN`) is the **owner**: always an admin, and the break-glass login if everything else
goes wrong. From it (or any admin) open **Users** in the panel to create people:

| | admin | dev |
|---|---|---|
| Use projects and chats: send prompts, queue, cancel, drafts, files, live view, notifications | yes | yes |
| Create / delete projects (this is where a project's sandbox is chosen) | yes | no |
| Adopt an existing Codex session, list local sessions | yes | no |
| Add Codex accounts, unblock accounts at their limit | yes | no |
| Approve or reject chat-to-chat sends from MCP | yes | no |
| Create / delete users, change roles, issue new tokens | yes | no |

Creating a user prints a personal token **once** (only a hash is stored). The user signs in with it, then can press
**Add passkey** to register their own; passkey logins sign in as that user. **New token** replaces a user's token and signs
out all their sessions; **Delete** removes their token, sessions and passkeys at once. Over `/mcp`, a dev's token gets the
everyday tools only; an admin's gets all 18.

Devs share the same project list (there is no per-project assignment). Note that a dev chatting in a project whose sandbox is
`danger-full-access` is effectively running commands as root, so keep such projects for admins you trust or give devs only
`workspace-write`/`read-only` projects.

### Adding Codex accounts

Every Codex account is added from the panel, including the first one. Dalang starts with no account (and never reads
`~/.codex`); the first time an admin opens the panel it goes straight to the sign-in step. Click **+ Account**, type a name,
press **Start login**. The gateway runs `codex login --device-auth` on the VM and shows a sign-in link and a code. Open the
link on any device, enter the code and approve with the Codex/ChatGPT account you want to add. When Codex reports that
account as logged in it joins the failover list (in the order added), survives restarts, and its folder is
`<STATE_DIR>/codex-accounts/<name>`, so backing up `STATE_DIR` backs up all of them. Admins only. The first account's `sessions`
folder is shared with the later ones so a chat can move between accounts. Until an account exists, chats fail with a
message telling an admin to add one.

A badge with a warning sign means Codex says that account is not logged in (for example its login expired). Dalang does
not store your Codex passwords or tokens: they stay in each home's `auth.json`. There is no "remove account" button yet;
delete the folder and its entry under `extra_homes` if you need to.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LZVR_TOKEN` | required | Access token, min 32 chars. Treat it like a root password. |
| `WORKSPACE_ROOT` | required | Projects must live under this folder (`/` allows everything). |
| `STATE_DIR` | `./state` | Database and uploads. |
| `HOST` / `PORT` | `127.0.0.1` / `9876` | Listen address. Keep loopback and put a TLS proxy in front. |
| `TRUST_PROXY` | off | Set `1` when a reverse proxy **on this machine** (nginx/Caddy) fronts the gateway, or list its IPs/CIDRs (`10.0.0.5,10.0.1.0/24`). Rate limiting then uses the client address that proxy saw. Without it, every visitor looks like `127.0.0.1` and ten bad tokens from anyone lock everyone out. Never trust addresses that are not your proxy. |
| `LZVR_RP_ID`, `LZVR_ORIGIN` | unset | Enable passkeys (hostname and full `https://` origin of the panel). |
| `LZVR_VAPID_SUBJECT` | origin | Contact URL for Web Push (`mailto:` or `https:`). |
| `LIMIT_BLOCK_MINUTES` | `60` | How long an account is skipped after a usage limit. |
| `LIMIT_REGEX` | built in | Case-insensitive regex that recognises a usage-limit error (see below). |
| `MCP_CROSS_SEND` | `approve` | `auto` lets one chat message another through MCP without approval. |
| `MCP_INJECT` | off | `1` gives every Codex turn this gateway's `/mcp` (see "MCP" below). Off by default; turn it on only after checking it works with your Codex version. |
| `MCP_URL` | `http://127.0.0.1:<PORT>/mcp` | Where Codex should reach `/mcp` when `MCP_INJECT=1`. |
| `CODEX_BIN` | `codex` | Path to the Codex binary. On native Windows use the full path to `codex.exe`. |

### Security

`WORKSPACE_ROOT=/` plus a project with `"sandbox": "danger-full-access"` means the token is a root shell: keep the
panel off the public internet (Tailscale/WireGuard/IP allowlist, or TLS proxy), and snapshot the VM first.
Ten wrong tokens from one address in a minute are blocked with 429. Everything Codex reads is sent to OpenAI as
context, so keep secrets (`.env`, keys) out of the folders you register, or use `"sandbox": "read-only"` and
a narrower `WORKSPACE_ROOT` (for example `/var/www`).

### Failover: two things to confirm on your first run

1. **How a usage limit looks.** The built-in regex is a best guess (`usage limit`, `rate limit`, `too many requests`,
   `exceeded your quota`, `limit reached`) and is applied only to the error message (or the last 1000 characters of
   stderr for a process that died), never to the whole event, so "Disk quota exceeded" or a line number `429` does not
   take an account offline. If the message says "try again in N minutes/hours" the account is skipped for that long
   (max 24 h), otherwise for `LIMIT_BLOCK_MINUTES`. When an account really hits its limit, look at the event stream;
   if it was not recognised, set `LIMIT_REGEX`.
   If a limit hits after the agent already did work, the next account is told to continue and not repeat finished
   steps instead of receiving the bare request again.
2. **Resuming on another account.** A session can only resume if the new account can see its session file. On start
   the gateway links `<home>/sessions` of every extra account to the first account's `sessions` folder. If an extra
   account already has its own `sessions` folder it is left alone and a warning is printed (merge it by hand).

## Use without the panel

All routes need `Authorization: Bearer $LZVR_TOKEN`.

```bash
bash scripts/smoke.sh        # create a project + chat, send a prompt, stream the events (real Codex)
```

REST: `/api/projects`, `/api/projects/:id/conversations` (body `{"worktree": true}` for an own worktree),
`/api/conversations/:id/{prompts,queue,cancel,draft,events}`, `/api/conversations/:id/git` and `.../git/{diff,message,mr-description,commit,revert,discard,merge}`,
`/api/sessions`, `/api/accounts`, `/api/approvals`, `/api/uploads`, `/api/push/*`, `/api/passkey/*`.
Design notes: `docs/superpowers/specs/2026-10-13-core-gateway-design.md`.

### MCP

Point an MCP client at `https://<host>/mcp` with the bearer token (Streamable HTTP, stateless). Tools: `list_projects`,
`create_project`, `delete_project`, `list_conversations`, `create_conversation`, `adopt_session`, `list_sessions`,
`get_conversation`, `send_prompt`, `list_queue`, `remove_queue_item`, `cancel_turn`, `set_draft`, `get_events`,
`list_accounts`, `unblock_accounts`, `get_approval`.

**Two kinds of caller.** An outside client using the main token gets all 18 tools. An agent running inside a chat
(with `MCP_INJECT=1`, each turn gets its own short-lived token bound to that chat, set up through
`-c mcp_servers.dalang.url=... -c mcp_servers.dalang.bearer_token_env_var=LZVR_MCP_TOKEN`) gets only
`list_projects`, `list_conversations`, `create_conversation`, `get_conversation`, `send_prompt`, `list_queue`,
`get_events`, `list_accounts`, `get_approval`. Its token works only on `/mcp`, dies when the turn ends, and the chat
it claims to be comes from the token, not from anything it sends. A `send_prompt` from an agent into a *different*
chat is held until you approve it in the panel (or `POST /api/approvals/:id/approve`).

**What this does and does not protect.** It stops an agent from messaging other chats or widening sandboxes through the gateway.
It is not a wall against a hostile agent on the same machine: an agent that
can read files and runs as root can still read `/etc/systemd/system/lzvr-dalang.service` (which holds the main token)
or the database. The gateway removes its own `LZVR_*` variables from the environment of every Codex process, but
keep secrets out of what Codex can read if that matters to you. Agents can also read other chats' events via `get_events`.

**Verify before relying on it.** The `-c mcp_servers...` keys follow Codex's documented MCP config for HTTP servers
but were not run against a real Codex here. With `MCP_INJECT=1`, start one chat and ask it to list its MCP tools;
if Codex rejects the config, unset `MCP_INJECT` (everything else keeps working).

## Develop

`LZVR_TOKEN=<32+ chars> WORKSPACE_ROOT=. npm run dev`, `npm test`, `npm run typecheck`.

## Scope

Built: core gateway, multi-account failover, panel + PWA + passkeys + Web Push, session adoption, MCP gateway.
Dropped: Docker-in-Docker test sandbox (the gateway runs directly on the VM).
Not verified against the real services in development: the real Codex limit message and cross-account resume, passkeys
and push in a real browser/phone, and the panel UI in a browser (all were tested with fakes or unit tests).
