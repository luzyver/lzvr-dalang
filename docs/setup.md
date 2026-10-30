# Setup and administration

Install and administer the server. For a local quick start, see the [README](../README.md#quick-start);
for development, see [CONTRIBUTING](../CONTRIBUTING.md).

- [Installation and updates](#install-on-the-vm-no-docker)
- [Terminals](#terminals-without-root) and [HTTPS](#nginx-https)
- [Sign-in](#signing-in), [users and roles](#users-and-roles), [accounts](#adding-codex-accounts)
- [Git and forges](#merge-requests-gh-and-glab), [per-user credentials](#each-users-own-git-setup)
- [Configuration](#configuration), [security](#security), [failover](#failover-two-things-to-confirm-on-your-first-run)

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
# Push and the installable app need HTTPS. Set these once a TLS proxy serves the panel:
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

To update later, run `scripts/update.sh` in the checkout: it pulls (`--ff-only`; `--no-pull` skips it), runs `npm ci`
when the lockfile changed, builds, restarts the service and waits for the port, printing the journal if it does not come
up. A failed pull or build leaves the running service alone. From your machine: `ssh server 'cd /opt/lzvr-dalang &&
scripts/update.sh'`. Don't run it from a Dalang chat: the restart stops the server running that chat.

A restart does not cut running chats off. On SIGTERM the panel stays up while running turns get `DRAIN_MINUTES`
(default 5) to finish; new prompts wait in their chat's queue meanwhile. A turn still running then is stopped and,
after the restart, continues in the same agent session ("continued after a restart" in the chat), ahead of the prompts
queued behind it. For that systemd must signal only node and wait long enough: `update.sh` adds the drop-in
`/etc/systemd/system/lzvr-dalang.service.d/drain.conf` with `KillMode=mixed` and `TimeoutStopSec=10min` the first
time; raise `TimeoutStopSec` with it when you set a longer `DRAIN_MINUTES`. Ctrl+C (SIGINT) and a crash do not wait.

## Terminals without root

The service runs as root, so a terminal in the code editor would be a root shell. That one is for the owner alone
(the main token, or a sign-in with an owner email). Admins and devs get terminals only with `TERMINAL_USER`, and
theirs run as that ordinary account, one that cannot use sudo; the owner's root terminals are never listed to them.
Use an account made for this alone, never one somebody logs in with (its password is locked below), and run the
`chgrp` lines only on project folders, never on `/root`, `/home` or `/`: they change everything below that folder,
and a group-writable `/root/.ssh` makes sshd refuse every key for root.

```bash
useradd -m -s /bin/bash dalang          # a new account: no sudo, wheel or admin group
passwd -l dalang                        # no password: nobody logs in as it, only the panel's terminals
# Let it work in the projects (here: a group shared with root, which the agents run as). One project folder at a time:
groupadd -f devs && usermod -aG devs dalang
P=/srv/projects/app
chgrp -R devs "$P" && chmod -R g+rwX "$P" && find "$P" -type d -exec chmod g+s {} +
sudo -u dalang git config --global --add safe.directory '*'   # repositories owned by root
# It must not read the main token or Dalang's state:
chmod 600 /etc/systemd/system/lzvr-dalang.service && chmod 700 /opt/lzvr-dalang/state && systemctl daemon-reload
```

Then `Environment=TERMINAL_USER=dalang` in the service and restart it. Every new terminal of an admin or dev then:

- **starts as that account** (`dalang@vm:~$`) with its home, its login shell and its own `~/.gitconfig` and `~/.ssh`
  (the git setup of Settings → Git & forges belongs to root and is not used there);
- **can never become root**: the shell is started through `setpriv --no-new-privs` (util-linux), so sudo, su and
  every other setuid program fail inside it, even if the account were later given sudo;
- **is refused** if the account does not exist, is root, is in the `sudo`, `wheel`, `admin` or `root` group, or is
  named in a sudoers file (checked each time a terminal opens).

Only those terminals change: the owner's terminals, the agents, the editor's file changes and git in Changes still run
as the service's user.
A terminal can only write where that account may, so give it the project folders (above) and the worktrees
(`<STATE_DIR>/worktrees`) if it should work in them; files it creates belong to it. On Windows and macOS
`TERMINAL_USER` is ignored: there Dalang usually runs as your own account, and so do its terminals.

## nginx (HTTPS)

Dalang listens on `127.0.0.1:9876` only, so put nginx in front. `nginx.conf` in this repo is a ready server block on
port 80 with **no ssl**: certbot adds the https block and the redirect itself. It keeps the live event stream unbuffered,
allows 60 MB uploads, rate-limits the sign-in endpoints, passes the WebSocket of the code editor's terminals on, and
passes the real client address (replacing `X-Forwarded-For`, so it cannot be forged). To use it:

1. Replace `panel.example.com` in the file and copy it to `/etc/nginx/conf.d/lzvr-dalang.conf`, then
   `nginx -t && systemctl reload nginx`.
2. Let certbot add TLS: `certbot --nginx -d panel.example.com`.
3. Add to the service environment and restart it: `LZVR_ORIGIN=https://panel.example.com`,
   `TRUST_PROXY=1`.

**Only certain IPs can open it.** The `geo $lzvr_allowed { ... }` block at the top of `nginx.conf` is the allowlist: list
the addresses or CIDR ranges that may reach the panel and API (yours, your office, your VPN) and everyone else gets
`403`. It ships with example addresses that match nobody, so until you edit it only the machine itself gets in. The check
sits inside the two app locations, not at server level, so certbot's validation (which comes from Let's Encrypt, any
address) and its renewals keep working. If another proxy or a CDN (Cloudflare, a load balancer) sits in front of nginx,
nginx sees that proxy's address instead of the visitor's, so you would need nginx's `realip` module before this list means
anything. For a stricter wall, also restrict ports 80/443 in the firewall (`ufw allow from <ip> to any port 443`), but keep
80 open to everyone until the certificate is issued, and again at renewal time unless you renew with the DNS challenge.

Open the panel at that URL (or `http://127.0.0.1:9876` through an SSH tunnel), sign in by email (see below), then turn on
**Notifications** in Settings → This device. Push and "install app" only work over HTTPS (or localhost).
Subscriptions belong to the signed-in user; each notification checks their current project, database or host access.
Approval notifications go only to eligible admins. Signing out removes the device's subscription. Old subscriptions
without a recorded user are discarded on upgrade and rebound when that browser next signs in.

## Signing in

The sign-in screen asks for an email and **Send code**: Dalang mails a 6-digit code through the mailer service
(`POST $MAILER_URL/mail/send`; the mailer's nginx must allow the VM's address). The code is valid for 5 minutes, can be
asked for again after 60 seconds, and dies after 5 wrong tries. The emails in `LZVR_OWNER_EMAILS` (comma-separated) sign
in as the owner; a panel user signs in with the email set on their user. Unknown emails get the same answer and no mail.
The cooldown also applies to unknown addresses. Delivery runs in the background: a mailer failure is logged on the
server and does not change the public response.
`MAIL_FROM` sets the sender (default: the mailer's). Without `MAILER_URL` the screen falls back to the access token.

**Local development:** `AUTH_BYPASS=true` skips sign-in entirely: every request is the owner. It is refused at start
unless `HOST` is a loopback address (`127.0.0.1`, `::1`, `localhost`). Never set it on the VM.

## Users and roles

The main access token (`LZVR_TOKEN`) is the **owner**: always an admin, and the break-glass login if everything else
goes wrong. From it (or any admin) open **Users** in the panel to create people:

| | admin | dev |
|---|---|---|
| Use projects and chats: send prompts, queue, cancel, drafts, files, live view, notifications | yes | yes |
| Create / delete projects (this is where a project's sandbox is chosen) | yes | no |
| Add Codex accounts, unblock accounts at their limit | yes | no |
| Approve or reject chat-to-chat sends from MCP | yes | no |
| Create / delete users, change roles, issue new tokens | yes | no |

Each user has an email (set when creating them, editable in the list): that is what they sign in with. Creating a user also
prints a personal API token **once** (only a hash is stored), for the HTTP/MCP API or signing in without email. **New token** replaces a user's token and signs
out all their sessions; **Delete** removes their token and sessions at once. Over `/mcp`, a dev's token gets the
everyday tools only; an admin's available tools also depend on the enabled integrations.

Each project has an **access** level, picked when it is added and changeable from its menu in the sidebar:

| Access | Who may open it |
|---|---|
| `all` (default) | everyone: the owner, admins and devs |
| `admin` | the owner and admins |
| `owner` | the owner only |

The owner always sees every project. Anyone else gets a 404 for a project they may not open, its chats and everything in
them (git, files, terminals, schedules, queue, approvals), and does not find it in lists, search or over `/mcp`. An agent sees
the projects of the user who sent its turn's prompt (plus its own); one with no such user sees only `all` projects (plus its
own). An admin may set anything but `owner`, so they cannot lock themselves out; `owner` is set by the owner. Note that a dev chatting in a project whose sandbox is
`danger-full-access` is effectively running commands as root, so keep such projects for admins you trust (access `admin`)
or give devs only `workspace-write`/`read-only` projects.

An upload waiting to be attached is private to its uploader and the owner. Once attached, downloading or reusing it
requires access to at least one project it was attached to; current project permissions apply even to the original
uploader. Upgrades recover these links from chat history and queued prompts. Legacy files with no such record remain
owner-only; upload them again if another user needs them.

## Adding Codex accounts

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

Accounts in Settings show their sign-in state. Use **Sign in again** on a signed-out account to renew its login;
the dispatcher skips those accounts until they are signed in. Usage-limit failover stays within the chat's backend.

## Claude Code accounts and permissions

Projects can use Claude Code instead of Codex; the backend can also be changed per chat. Install the `claude` CLI
on PATH or set `CLAUDE_BIN`, then add accounts in Settings. Each account has its own `CLAUDE_CONFIG_DIR`, with
usage-limit failover within that backend.

Claude Code has no OS sandbox. A `read-only` project uses the default permission mode: headless runs refuse tools
that require confirmation, but can read files and use configured MCP tools. `workspace-write` permits edits and
Bash without filesystem isolation; `danger-full-access` bypasses permission checks. See [Security](#security)
and the [trust boundaries](design.md#trust-boundaries) before choosing a mode.

## Merge Requests: gh and glab

**Create Merge Request** runs the forge's own CLI on the VM: `gh` for GitHub, `glab` for GitLab. Install only the one
your remotes need, and sign it in once **as the user Dalang runs as** (the CLI keeps its login in that user's home):

```bash
# GitHub (github.com or GitHub Enterprise). Install: https://github.com/cli/cli#installation (Windows: winget install GitHub.cli)
gh auth login                                        # Enterprise: gh auth login --hostname github.example.com

# GitLab (gitlab.com or self-hosted). Install: https://gitlab.com/gitlab-org/cli#installation (Windows: winget install GLab.GLab)
glab auth login                                      # self-hosted: glab auth login --hostname gitlab.example.com
```

Then restart Dalang so the new binary is on its `PATH`, or point `GH_BIN` / `GLAB_BIN` at it (on Windows the full path
to `gh.exe` / `glab.exe`). The account needs write access to the repository; `git push` itself still uses the VM's SSH key
or credential helper, as for commits.

**From the panel instead of a shell**: **Settings → Git & forges** does the same setup for the owner as the user Dalang
runs as (one tab each: Identity, SSH, GitHub, GitLab). The CLIs still have to be installed; everything else lands where
a manual setup would, and Dalang stores no token itself. The menu items of each account (**⋯**) upload a key or set
up HTTPS. Panel users other than the owner get their own setup there instead (see "Each user's own git setup" below).

- **Commit identity**: `git config --global user.name` / `user.email`.
- **SSH** (remotes like `git@host:owner/repo.git`): lists the public keys in `~/.ssh` with their fingerprints and
  creates new ed25519 keys (no passphrase, any name such as `id_ed25519_work`; an existing file is never overwritten).
  **Test SSH** runs `ssh -T git@<host>`. A host seen for the first time is added to `known_hosts` there
  (`StrictHostKeyChecking=accept-new`), so the first push does not stop at the "continue connecting?" question.
- **SSH aliases**, for several accounts on one forge: lists the single-name `Host` blocks of `~/.ssh/config` and adds
  new ones (`Host github.com-work` → `HostName github.com`, `User git`, the chosen key, `IdentitiesOnly yes`), marked
  with a `# Added by Dalang` comment. A remote then reads `git@github.com-work:owner/repo.git`; Merge Requests still
  resolve the real host (see below). Removing an alias deletes only its own block (and that marker); the rest of the
  file, wildcard blocks and other comments included, stays as it is.
- **GitHub / GitLab**: signs `gh` / `glab` in with a personal access token (passed on stdin), or for GitHub with the
  browser sign-in (one-time code, like adding a Codex account; it asks for `admin:public_key` too). **Add id_ed25519** (one button per key)
  uploads one of the server's public keys to the signed-in account (`gh ssh-key add` / `glab ssh-key add`).
- **HTTPS** (remotes like `https://host/owner/repo.git`): "Also use this login for git over HTTPS" (or **Use for HTTPS**)
  makes git ask the CLI for the password: `gh auth setup-git` for GitHub, and for GitLab a
  `credential.https://<host>.helper` of `glab auth git-credential` (needs a glab recent enough to have that command).
  Signing out of a host's last account removes that helper again. Git that Dalang runs never opens a login prompt or
  window (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`): a missing login fails with a message instead. A helper for
  `https://host` does not cover an `http://host` remote; switch the remote to https.

## Each user's own git setup

Only the owner (main token or owner sign-in) works with the server's git setup above. Every other panel user, admins
included, has their own under `<STATE_DIR>/git-users/<user id>/`, managed in their own **Settings → Git & forges**:

- `gitconfig`: their author and HTTPS credential helpers (`GIT_CONFIG_GLOBAL`). It starts with an empty
  `credential.helper`, which drops system-wide helpers such as Git Credential Manager and the logins stored there.
- `ssh/`: their keys, aliases (`config`, keys named by full path) and `known_hosts`. ssh runs with `-F` that config,
  `-i` each of their keys, `IdentitiesOnly=yes` and no agent keys, so it never falls back to the server's `~/.ssh`.
- `gh/`, `glab/`: their forge logins (`GH_CONFIG_DIR`, `GLAB_CONFIG_DIR`; gh with `--insecure-storage`, so the token
  stays in that folder rather than the shared OS keyring).

That setup is used whenever Dalang works for them: their commits, pulls, pushes and Merge Requests from the Changes
tab, and the agent turns of their prompts (whose own `git commit` / `git push` get the same environment). A prompt one
agent sends another (MCP `send_prompt`, approved or not) runs for the user the sending agent worked for. Their author
is set with `GIT_AUTHOR_*` / `GIT_COMMITTER_*`, which beats a repository's own `user.name`; **Edit** in the Changes tab
gives them another author for one project, kept by Dalang rather than in the repository's config (which is shared).

A user who has not set anything up has no credentials at all: commits are refused until they set an author, and pushes,
pulls of private remotes and Merge Requests fail with a pointer to Settings → Git & forges. They never fall back to the
server's. Deleting a user deletes their folder.

This decides which account is used and who authors a commit. It is not isolation: everything runs as one OS user, so an
agent (or anything it is told to run) could read another user's files under `git-users/`. Real separation needs one
OS user or container per user.

How Dalang picks the CLI and the repository:

- **From the remote of the chat's branch.** A host name containing `github` means `gh`, one containing `gitlab` means
  `glab`. A server named otherwise (`git.example.com`) needs `GIT_FORGE=github` or `GIT_FORGE=gitlab`; it applies to
  every project on this Dalang.
- **SSH aliases work.** A remote like `git@github.com-work:acme/app.git` (one key per account in `~/.ssh/config`) is
  resolved with `ssh -G` to the real host, and the CLI is told the repository explicitly (`gh --repo github.com/acme/app`,
  `glab --repo https://gitlab.example.com/group/sub/app`), since neither CLI knows such aliases. Subgroups work.
- **Nothing is asked.** `gh` runs with `GH_PROMPT_DISABLED=1`, `glab` with `--yes` and `NO_PROMPT=1`. Dalang pushes the
  branch first, so the CLI does not offer to.
- **The target is the branch the chat started from** (`base` of the worktree), not whatever the project folder has
  checked out now. A chat started from a detached HEAD cannot open one.

Known limits:

- When a Merge Request is already open for the branch, `gh`'s error names its address and Dalang shows that link.
  `glab`'s message does not include it, so on GitLab this case shows up as an error; the existing MR is untouched.
- Errors from the CLI (not signed in, no access, branch protection, ...) are shown as they are on the Changes page.
- Only `gh` was exercised against a fake CLI in the tests; neither was run against the real GitHub or GitLab here.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LZVR_TOKEN` | required | Access token, min 32 chars. Treat it like a root password. |
| `WORKSPACE_ROOT` | required | Projects must live under this folder (`/` allows everything). |
| `STATE_DIR` | `./state` | Database and uploads. |
| `LZVR_SECRET_KEY` | `<STATE_DIR>/secret.key` | Encrypts the passwords, keys and tokens stored in the database (see "Security"). Any text; keep it, since without it they cannot be read. |
| `HOST` / `PORT` | `127.0.0.1` / `9876` | Listen address. Keep loopback and put a TLS proxy in front. |
| `TRUST_PROXY` | off | Set `1` when a reverse proxy **on this machine** (nginx/Caddy) fronts the gateway, or list its IPs/CIDRs (`10.0.0.5,10.0.1.0/24`). Rate limiting then uses the client address that proxy saw. Without it, every visitor looks like `127.0.0.1` and ten bad tokens from anyone lock everyone out. Never trust addresses that are not your proxy. |
| `LZVR_ORIGIN` | unset | Full `https://` origin of the panel; the Web Push contact when `LZVR_VAPID_SUBJECT` is unset. |
| `LZVR_VAPID_SUBJECT` | origin | Contact URL for Web Push (`mailto:` or `https:`). |
| `LIMIT_BLOCK_MINUTES` | `60` | How long an account is skipped after a usage limit. |
| `DRAIN_MINUTES` | `5` | On a restart (SIGTERM, `scripts/update.sh`, `autostart.cmd restart`), how long running turns may still finish before they are cut off; a cut-off turn continues in its session after the restart. `0` cuts them off at once. On the VM keep the unit's `TimeoutStopSec` longer (see "Install on the VM"). |
| `LIMIT_REGEX` | built in | Case-insensitive regex that recognises a usage-limit error (see below). |
| `MCP_CROSS_SEND` | `approve` | `auto` lets one chat message another through MCP without approval. |
| `MCP_INJECT` | off | `1` gives every Codex turn this gateway's `/mcp` (see [MCP](integrations.md#mcp)). Off by default; turn it on only after checking it works with your Codex version. |
| `MCP_URL` | `http://127.0.0.1:<PORT>/mcp` | Where Codex should reach `/mcp` when `MCP_INJECT=1`. |
| `AUTO_MEMORY` | on | `0` stops keeping facts from each finished turn in the project memory (see [Project memory](design.md#project-memory)); what agents and people save is still kept and shown. |
| `CONTEXT_COMPACT_TOKENS` | `100000` | Native compaction window for chat turns, from `100000` to `1000000` tokens. `0` leaves the CLI's own settings unchanged; it does not disable native compaction. See [Active chat context](design.md#active-chat-context). |
| `AUTO_TITLE` | on | `0` turns off generated chat titles: the chat's agent gives each new chat a short title from its first prompt (one small read-only request, counted against the account's usage), else the first prompt is the title. |
| `CODEX_BIN` | `codex` | Path to the Codex binary. On native Windows use the full path to `codex.exe`. |
| `GH_BIN` / `GLAB_BIN` | `gh` / `glab` | The GitHub and GitLab CLIs that **Create Merge Request** runs. Only the one your remote needs has to be installed. |
| `GIT_FORGE` | from the remote | `github` or `gitlab`, for a self-hosted server whose host name contains neither word. |
| `TERMINAL_SHELL` | PowerShell / login shell | The shell the code editor's terminals start (a path, no arguments). |
| `TERMINAL_USER` | unset | Linux: the account the code editor's terminals of admins and devs run as (the owner's run as the service's). Unset, only the owner has terminals. It may not be root or able to use sudo, and its shells can never gain rights (see "Terminals without root"). |

## Security

`WORKSPACE_ROOT=/` plus a project with `"sandbox": "danger-full-access"` means the token is a root shell: keep the
panel off the public internet (Tailscale/WireGuard/IP allowlist, or TLS proxy), and snapshot the VM first.
Ten wrong tokens from one address in a minute are blocked with 429. Everything Codex reads is sent to OpenAI as
context, so keep secrets (`.env`, keys) out of the folders you register, or use `"sandbox": "read-only"` and
a narrower `WORKSPACE_ROOT` (for example `/var/www`).

**Secrets in the database are encrypted.** SSH hosts, SQL editor connections (and their SSH tunnels), the ClickUp
token, other MCP servers' tokens and environment, and the push key are stored with AES-256-GCM, so `lzvr.db` alone (a
copy, a backup, an agent reading it) does not give them away. The key is `LZVR_SECRET_KEY`, which no agent, terminal
or git process Dalang starts receives (no `LZVR_*` variable does). Without it, Dalang makes `<STATE_DIR>/secret.key`
and warns at start: that file sits next to the database, so for agents that can read the state folder, put its content
in `LZVR_SECRET_KEY` (the systemd unit's `Environment=` or `.env`) and delete the file. Values stored in clear by an
earlier version are encrypted at the next start and the database is compacted; older copies and backups of it still
hold them in clear. A wrong key stops the start instead of losing anything. This is not a wall against an agent
running as the same OS user, which can still read Dalang's service file or process environment; only running agents
as another OS user is.

## Failover: two things to confirm on your first run

1. **How a usage limit looks.** Claude Code marks a refusal at the account's usage limit as such (`usage_limit_reached`,
   or a `rate_limit_event` that is `rejected`), with when it resets; that is trusted whatever the text says. Everything
   else (and all of Codex) is judged by a regex over the texts the CLIs print today (`usage limit`, `rate limit`,
   `too many requests`, `exceeded your quota`, `limit reached`, `hit your ... limit`, `out of credits`, `spend cap`),
   applied only to the error message (or the last 1000 characters of stderr for a process that died), never to the
   whole event, so "Disk quota exceeded" or a line number `429` does not take an account offline. The account is
   skipped until the limit resets (max 24 h): the reset Claude Code reports, "try again in N minutes" or Codex's
   "try again at 3:04 PM", else the usage window the CLI last reported as used up, else `LIMIT_BLOCK_MINUTES`. When
   an account really hits its limit and the chat does not move on, look at the event stream; if it was not
   recognised, set `LIMIT_REGEX` (it replaces the built-in regex, not Claude Code's marking).
   If a limit hits after the agent already did work, the next account is told to continue and not repeat finished
   steps instead of receiving the bare request again.
2. **Resuming on another account.** A session can only resume if the new account can see its session file. On start
   the gateway links `<home>/sessions` of every extra account to the first account's `sessions` folder. If an extra
   account already has its own `sessions` folder it is left alone and a warning is printed (merge it by hand).
