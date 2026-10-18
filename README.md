# lzvr-dalang

*The puppeteer behind the screen.* lzvr-dalang (the panel calls itself Dalang) is a self-hosted control room for the **Codex CLI**: a web panel
(installable on your phone) and an HTTP/MCP API that run headless `codex exec` sessions on your own VM, with failover
between your own Codex accounts. Part of the `lzvr` toolbox (environment variables are `LZVR_*`).

- **Projects and chats**: register folders as projects; each project has parallel chats, each with its own Codex
  session, draft and prompt queue. **Add project → Clone a repository** clones one into a new folder under
  `WORKSPACE_ROOT` first, with the git login of whoever adds it.
- **Live view**: tool activity, commands and answers stream into the panel over SSE.
- **Worktree per chat** (optional, git projects): "New chat in own worktree" in a project's `⋯` menu gives the chat a
  branch `dalang/<id>` from the project's HEAD, checked out under `<STATE_DIR>/worktrees/<chat id>`. Its agent works only
  there, so parallel chats never write over each other. Deleting the chat removes the worktree (uncommitted work there is
  lost) and the branch too, locally and on the remote, unless it has commits that were never merged. The branch name in
  Changes renames it (say to `feat/login`); a pushed branch moves on the remote too, unless a Merge Request is open for it.
- **Changes**: the branch button in a chat's header opens the **Changes** tab of the inspector beside the chat: what git
  sees in the folder that chat works in, with each file's diff (unified or side by side, syntax highlighted). Commit all or selected files, revert one file, discard everything, and open a Merge
  Request (see below). Dalang never merges a branch on its own: a worktree chat's work reaches the target branch only
  through a reviewed Merge Request / pull request (or a sync you start, see "More git" below). These actions are refused
  while an agent is running in the same folder, and in `read-only` projects they are admin only.
  Under the commit button the tab says which credentials are used: the author (and whether the repository sets its own;
  **Change** sets one for this repository only, `git config --local`, shared by its worktrees, and **Use the global
  author** drops it again),
  the remote branch the push goes to, and how: over SSH with which key (`ssh -G`, so `~/.ssh/config` aliases count) or
  over HTTPS with which credential helper. The Merge Request card names the CLI and host that open it. **Check account**
  asks the forge who that is (`ssh -T`, `gh`/`glab auth status`), e.g. "GitHub knows this key as luzyver".
  **Pull** (the arrow next to Refresh) fast-forwards the checked-out branch from its upstream (or the same name on
  `origin`); a branch that has gone its own way is refused rather than merged. **History** (the clock next to the
  branch name) lists the commits of every local and remote branch and tag as a graph, like `git log --graph`; a commit
  opens to its message, the files it changed and each file's diff (a merge: against its first parent). In a chat on the project folder, the
  branch name opens **Branches**: switch to a local branch, check out a remote one (it becomes a local branch tracking
  it), or type a new name to create a branch from the current HEAD (it gets its own branch on the remote with its first
  commit). Uncommitted changes come along; git refuses a switch that would overwrite them. The bin next to a local
  branch deletes it here only (the remote keeps its copy); not the checked-out or the default branch, and one with
  commits that are neither in the current branch nor on its remote only after a second confirmation. A worktree chat
  stays on its own branch.
  A commit is **pushed right away** unless **Push** under the message is unticked (to the branch's upstream, or to
  `origin` under the same name, which becomes its upstream; a worktree chat's `dalang/<id>` branch thus appears on the
  remote, ready for a Merge Request); the arrow-up button with a count pushes what is left. Without a
  remote nothing is pushed; a failed push (credentials, rejected) is shown and the
  local commit stays. The push uses the VM's own git credentials (SSH key or credential helper of the user Dalang runs as)
  and never prompts. Deleting a worktree chat also deletes its branch on the remote, but only when it is merged into the
  project folder's branch and nobody pushed more to it since; an unmerged branch stays there and locally.
  Commits use the machine's git identity, or `Dalang <dalang@localhost>` when it has none. **Generate** asks
  the chat's own agent (same CLI and model) for a one-line Conventional Commit subject (`feat: Add ...`), given the
  selected diffs, the repo's recent commit subjects and the chat's last requests. For a branch with commits to
  propose, **Generate description** writes a Merge Request description (`## Title`, `## Summary`, `## Changes`, ...) from
  the branch's commits and its diff against the branch it merges into. **Copy Markdown** copies the Markdown for
  GitLab/GitHub, and the Merge Request text box gets it too (the Title line as title, the other sections as description;
  editable before creating it). Admins can change both instructions in **Generate prompts**
  (the same for Codex and Claude Code). These runs are read-only, have no tools, keep no session
  (`codex exec --ephemeral`, `claude --no-session-persistence`) and use the same account failover; they do count against
  the account's usage.
- **More git in Changes**:
  - **Sync**: Refresh fetches first, so the tab knows how far the branch is from its upstream. When the remote has
    commits the branch lacks, a card offers **Pull** (fast-forward), or, once the two went apart, **Rebase onto it** /
    **Merge it** (and, for a feature branch you rebased, a force push with a lease). When the branch a Merge Request
    would go into moved on, another card rebases onto it or merges it in. Uncommitted changes are put aside for the
    time (`--autostash`).
  - **Conflicts**: a merge, rebase, cherry-pick, revert or stash that stops on conflicts marks those files `U`. Each
    one's menu keeps this branch's side, takes the incoming one, or marks it resolved once edited (refused while
    conflict markers are left). **Ask the agent** hands the files to the chat's agent instead; **Continue** finishes
    the operation and **Abort** puts everything back.
  - **Amend and undo**: **Amend last commit** puts the picked files and the message into the last commit; the pencil
    next to the last commit rewords it, and the undo arrow takes it back (`reset --soft`: its changes stay). A commit
    already on the remote is replaced there with a lease after a second confirmation, and never on the default branch.
  - **Hunks**: in a changed file's diff each hunk has a checkbox; a file with only some ticked commits only those (the
    rest stays in the working copy).
  - **Stashes** (the box icon): put every change, new files too, aside with a note, look at each stash's files and
    diffs, and pop, apply or drop them. Git keeps one list per repository, so worktree chats share it.
  - **Agent checkpoints** (the circular arrow): before and after every agent turn (not in `read-only` projects) the
    whole folder is saved as a commit under `refs/dalang/checkpoints/<chat>/`, without touching the branch, the index
    or the files. The dialog lists each turn's prompt with the files it changed and their diffs; **Undo turn** puts the
    files back as they were before it (later changes too; commits and branches stay), **After** as they were right
    after it, and **Undo the last restore** takes a restore back. A chat's checkpoints go with the chat.
  - **History** gains **Cherry-pick**, **Revert** and **Tag** (annotated with a message, pushed if asked) on a commit,
    and **Compare**: two branches, tags or commits side by side, as a Merge Request from one into the other would be.
  - **The Merge Request after it is opened**: its state, CI checks, review decision and comments (inline ones too)
    come from `gh pr view` / `glab api`. **Address comments** and **Fix checks** send them to the chat's agent as a
    prompt; **Merge** merges it on the forge (squash, merge commit or rebase).
- **Create Merge Request**: **Create Merge Request** on the Changes page pushes the chat's branch and opens a Merge
  Request (GitLab, through `glab`) or pull request (GitHub, through `gh`). A worktree chat proposes its `dalang/<id>`
  branch into the branch it started from. A plain chat proposes whatever branch the project folder has checked out into
  the remote's default branch (`origin/HEAD`, else `main` or `master`); on the default branch itself there is nothing to
  open, so the box is hidden. The text box above it is its text: first line the title (empty: the last commit's subject), the rest the
  description, so **Generate description** fills both. The CLI runs with the server's own login (`gh auth login` /
  `glab auth login` once on the VM, as the user Dalang runs as) and never prompts. GitHub or GitLab is told from the
  remote's host name (`GIT_FORGE` overrides it for hosts named otherwise). The link is kept per chat and branch and shown on the Changes page;
  later commits are pushed to the same branch, so the MR follows them. When one is already open for the branch, its
  address is returned instead (GitHub). Setup: see "Merge Requests: gh and glab", or **Settings → Git & forges** in the panel.
- **Code editor**: the code icon in a chat's header opens the folder that chat works in (its worktree, else the project
  folder) in a new browser tab, laid out like VS Code: a file tree on the left with git's marks (M, U, A, D), open files
  as tabs (CodeMirror 6: highlighting for most languages, find and replace, folding, multiple cursors) and terminals
  below. The tree creates, renames, deletes, uploads (also by dropping files onto a folder) and downloads files and
  folders. The keys are VS Code's: `Ctrl P` goes to a file, `Ctrl Shift P` lists every command with its key, `Ctrl Shift O`
  goes to a symbol of the file, `Ctrl G` to a line, `Ctrl Shift F` / `Ctrl Shift H` search and replace across all files
  (case, whole word, regex, files to include/exclude), `Ctrl K S` saves all, `Ctrl B` hides the side bar, ``Ctrl ` ``
  the terminal (``Ctrl Shift ` `` opens another), `Alt Z` wraps lines, `Ctrl =` / `Ctrl -` zoom. **Blame** (above the
  file) shows who last changed each line, and clicking a line opens that commit; **History** lists the commits that
  changed the file (following renames). In the file `Ctrl D`,
  `Ctrl Shift L`, `Ctrl Alt ↑/↓` (cursors), `Alt ↑/↓` (move line), `Ctrl /` (comment), `Ctrl Shift [` (fold) and the rest.
  The few the browser keeps for itself have stand-ins: `Alt W` closes a tab (`Ctrl W`), `Alt N` makes a new file,
  `Alt Shift T` reopens a closed tab, `Ctrl Alt ←/→` and `Alt 1`–`9` switch tabs (`Ctrl Tab`). A file
  that changes on disk (the agent, a terminal) reloads by itself, or, with unsaved edits, says so and lets you pick
  whose version stays; a save never silently overwrites a newer file. Saving and every other change follow the agent's
  rules: refused in a `read-only` project, and while an agent is working in that folder (the status bar says so).
  `.git` is never touched. **Terminals**: the owner's run as the account Dalang runs as (root on a VM); admins and
  devs get terminals only once `TERMINAL_USER` is set, and theirs run as that account, without root and without sudo
  (see "Terminals without root"), and never see the owner's. PowerShell on Windows, the login shell elsewhere
  (`TERMINAL_SHELL` picks another), started in the chat's folder without Dalang's `LZVR_*` secrets; each tab names
  the account it runs as. They outlive the tab: reopening the editor re-attaches and
  replays their recent output; one nobody has looked at for an hour is closed, as are a chat's when it is deleted. On a
  phone the editor shows one pane at a time (Files, Editor, Terminal). Files over 5 MB and binary files open as a
  download only.
- **Search and commands**: `Ctrl K` / `⌘K` (or the box at the top of the sidebar) opens the command palette. It finds
  chats by title and searches every project's chats: generated titles, prompts and the agents' answers (not commands or
  their output). Every word has to occur; a result opens the chat scrolled to that message. It also runs actions: a new
  chat in a project, Changes, Settings, the theme.
- **Scheduled prompts**: the clock in a chat's header (the **Schedules** tab of the inspector) queues a prompt into that chat on a cron schedule
  (`minute hour day month weekday` in the server's time zone, or `@hourly`, `@daily`, ...), e.g. a nightly
  `npm audit` summary. The agent continues the same conversation, and the usual push notification comes when the turn
  ends. A run is skipped while the same prompt is still waiting in the queue; runs missed while the gateway was down
  are made up once, not one by one. **Run now** queues it off schedule. All schedules are listed under
  **Scheduled** in the sidebar. Anyone who may send prompts may schedule them.
- **Account failover**: with two or more of *your own* Codex accounts, a usage limit moves the same turn to the next
  account and resumes the session.
- **Email sign-in + push**: sign in with a 6-digit code mailed to you (through the mailer service), installable PWA, Web Push when a turn finishes,
  fails or needs input.
- **MCP gateway** at `/mcp` (17 tools) so other agents can drive chats, and a chat's agent can start sub-agents and hear back from them; messages between other chats can require approval.
- **ClickUp Chat history** (optional): read-only MCP tools that let the owner's chats read their ClickUp Chat
  messages, e.g. "what did I work on last week?" (see "ClickUp" below).
- **More MCP servers** (optional): Context7, Playwright, Sentry or any other, given to the agents' turns; the
  owner's only, unless one is marked for all users (see "Other MCP servers" below).
- **Code memory** (optional): a graph of every project's code from codebase-memory-mcp, kept fresh by Dalang, that
  every user's chats query through `/mcp`, each on the projects its user may open (see "Code memory" below).
- **SQL editor**: **SQL Editor** in the sidebar opens `/sql` in its own tab, for the whole panel rather than one chat:
  PostgreSQL, MySQL, MariaDB, SQLite, MongoDB and Redis connections, their tables, query consoles and a result grid. Each connection
  says whether agents may use it, read-only or read-write (see "SQL editor" below).

- **Claude Code too**: a chat can run on Claude Code instead of Codex (chosen per project when it is added; such a project shows a `CC` badge). Needs the
  `claude` CLI on PATH (or `CLAUDE_BIN`). Accounts are added in Settings ("Claude Code accounts"), each with its own
  `CLAUDE_CONFIG_DIR`, with the same failover. Claude Code has no OS sandbox: `read-only` runs in the default permission mode, where a headless run is refused
  every tool that would need asking (edits, Bash that changes things) but can read and use this gateway's MCP tools,
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

### Terminals without root

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

### nginx (HTTPS)

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

### Signing in

The sign-in screen asks for an email and **Send code**: Dalang mails a 6-digit code through the mailer service
(`POST $MAILER_URL/mail/send`; the mailer's nginx must allow the VM's address). The code is valid for 5 minutes, can be
asked for again after 60 seconds, and dies after 5 wrong tries. The emails in `LZVR_OWNER_EMAILS` (comma-separated) sign
in as the owner; a panel user signs in with the email set on their user. Unknown emails get the same answer and no mail.
`MAIL_FROM` sets the sender (default: the mailer's). Without `MAILER_URL` the screen falls back to the access token.

**Local development:** `AUTH_BYPASS=true` skips sign-in entirely: every request is the owner. It is refused at start
unless `HOST` is a loopback address (`127.0.0.1`, `::1`, `localhost`). Never set it on the VM.

### Users and roles

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
everyday tools only; an admin's gets all 18.

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

### Merge Requests: gh and glab

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

### Each user's own git setup

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

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LZVR_TOKEN` | required | Access token, min 32 chars. Treat it like a root password. |
| `WORKSPACE_ROOT` | required | Projects must live under this folder (`/` allows everything). |
| `STATE_DIR` | `./state` | Database and uploads. |
| `HOST` / `PORT` | `127.0.0.1` / `9876` | Listen address. Keep loopback and put a TLS proxy in front. |
| `TRUST_PROXY` | off | Set `1` when a reverse proxy **on this machine** (nginx/Caddy) fronts the gateway, or list its IPs/CIDRs (`10.0.0.5,10.0.1.0/24`). Rate limiting then uses the client address that proxy saw. Without it, every visitor looks like `127.0.0.1` and ten bad tokens from anyone lock everyone out. Never trust addresses that are not your proxy. |
| `LZVR_ORIGIN` | unset | Full `https://` origin of the panel; the Web Push contact when `LZVR_VAPID_SUBJECT` is unset. |
| `LZVR_VAPID_SUBJECT` | origin | Contact URL for Web Push (`mailto:` or `https:`). |
| `LIMIT_BLOCK_MINUTES` | `60` | How long an account is skipped after a usage limit. |
| `LIMIT_REGEX` | built in | Case-insensitive regex that recognises a usage-limit error (see below). |
| `MCP_CROSS_SEND` | `approve` | `auto` lets one chat message another through MCP without approval. |
| `MCP_INJECT` | off | `1` gives every Codex turn this gateway's `/mcp` (see "MCP" below). Off by default; turn it on only after checking it works with your Codex version. |
| `MCP_URL` | `http://127.0.0.1:<PORT>/mcp` | Where Codex should reach `/mcp` when `MCP_INJECT=1`. |
| `AUTO_TITLE` | on | `0` turns off generated chat titles: the chat's agent gives each new chat a short title from its first prompt (one small read-only request, counted against the account's usage), else the first prompt is the title. |
| `CODEX_BIN` | `codex` | Path to the Codex binary. On native Windows use the full path to `codex.exe`. |
| `GH_BIN` / `GLAB_BIN` | `gh` / `glab` | The GitHub and GitLab CLIs that **Create Merge Request** runs. Only the one your remote needs has to be installed. |
| `GIT_FORGE` | from the remote | `github` or `gitlab`, for a self-hosted server whose host name contains neither word. |
| `TERMINAL_SHELL` | PowerShell / login shell | The shell the code editor's terminals start (a path, no arguments). |
| `TERMINAL_USER` | unset | Linux: the account the code editor's terminals of admins and devs run as (the owner's run as the service's). Unset, only the owner has terminals. It may not be root or able to use sudo, and its shells can never gain rights (see "Terminals without root"). |

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
`/api/conversations/:id/{prompts,queue,cancel,draft,events}`, `/api/conversations/:id/git` and `.../git/{diff,message,mr-description,commit,revert,discard,pull,branches,branch,branch/delete,pull-request}`,
`/api/search?q=`, `/api/conversations/:id/schedules`, `/api/schedules` (`/:id`, `/:id/run`, `/preview?cron=`),
`/api/accounts`, `/api/approvals`, `/api/uploads`, `/api/push/*`.
Design notes: `docs/superpowers/specs/2026-10-13-core-gateway-design.md`.

### MCP

Point an MCP client at `https://<host>/mcp` with the bearer token (Streamable HTTP, stateless). Tools: `list_projects`,
`create_project`, `delete_project`, `list_conversations`, `create_conversation`, `get_conversation`,
`send_prompt`, `list_queue`, `remove_queue_item`, `cancel_turn`, `set_draft`, `get_events`, `list_accounts`,
`unblock_accounts`, `get_approval`, `list_models`, `set_model`.

**Two kinds of caller.** An outside client using the main token gets all 17 tools. An agent running inside a chat
(with `MCP_INJECT=1`, each turn gets its own short-lived token bound to that chat, set up through
`-c mcp_servers.dalang.url=... -c mcp_servers.dalang.bearer_token_env_var=LZVR_MCP_TOKEN`, plus
`default_tools_approval_mode="approve"` since `codex exec` cannot ask before an MCP call; Claude Code gets
`--mcp-config` and `--allowedTools=mcp__dalang` for the same reason) gets only
`list_projects`, `list_conversations`, `create_conversation`, `get_conversation`, `send_prompt`, `list_queue`,
`get_events`, `list_accounts`, `get_approval`, `list_models`, `set_model`. Its token works only on `/mcp`, dies when the turn ends, and the chat
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

**Sub-agents.** A chat's agent decides itself when to split work over sub-agents, how many and on which model:
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

### ClickUp

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

### Other MCP servers

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

### Agents and git

By default a chat's agent does not commit or push: you do that from the chat's **Changes** tab (commit, push, Merge
Request), which Dalang runs with its own git, outside any turn. **Settings → Model & effort → Commits and pushes**
(admins) has a switch for each.

- **Told**: every turn is told not to commit or push, even when asked, and to leave its changes ready for you.
- **Blocked** in the agent's own git, for Codex and Claude Code alike, through git config in the turn's environment
  (`GIT_CONFIG_COUNT`, read by every git it runs): `core.hooksPath` points at `scripts/agent-git-hooks`, whose
  `pre-commit` and `pre-merge-commit` refuse, and every push URL is rewritten (`pushInsteadOf`) to a path that cannot
  exist. Fetching, branches, stashes and the rest work as before.
- **Limits**: `--no-verify` skips the commit hooks, and the hooks path leaves the repository's own git hooks out of the
  agent's git. This stops habit, not an agent set on getting round it; a push needs more (an explicit `pushurl`).


**Settings → MCP → Code memory** (the owner only) turns on a graph of each project's code (symbols, calls, imports,
HTTP routes) from [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) (CBM), so agents answer
"who calls this", "what does this change touch" or "how does this fit together" from the graph instead of grepping
file by file. Give the path of the CBM binary (a release from its GitHub page; nothing to configure in the agents),
**Test binary**, turn it on.

- **Dalang runs it**: one CBM session for the whole server, started with Dalang's state dir as its folder. A project
  is indexed only when you click **Index** (later **Reindex**) in the tab, never on its own: not after turns, pulls or
  edits, so indexing never takes the machine by surprise. A first index uses several cores for seconds to minutes;
  indexing again only reads what changed and takes seconds. The tab lists each project's index, and marks it
  **files changed since** when the project's git state (HEAD or uncommitted changes) differs from the one it indexed.
  Turns are told when their graph was built, so they know newer code is not in it.
- **Deleting a project** deletes its graph from CBM too (unless another project on the same folder shares it), also
  when the project goes while its index still runs. One CBM cannot delete right then (code memory off) is deleted
  when the next CBM session starts.
- **Chats query it through `/mcp`**, as `code_search_graph`, `code_trace_path`, `code_get_code_snippet`,
  `code_get_architecture`, `code_query_graph` and the other read tools, on their own chat's project (or another project
  their user may open, by `project_id`). CBM itself would show every indexed repository to anyone; through the gateway
  a chat never reaches a project its user may not open. Indexing, deleting and listing other repositories stay with
  Dalang. Every user's chats get it, so it needs `MCP_INJECT=1` like the rest of `/mcp`.
- **Turns are told** (next to the sub-agent and database guides) that the project has a graph and to use it before
  grepping. A chat in its own worktree uses the project folder's graph, and is told to read files it changed itself.
- **Hooks** (on by default, a checkbox in the tab): turns also run `scripts/code-memory-hook.mjs` next to their own
  searches. It hands the hook event to CBM's `hook-augment` with the project folder as its folder, so the agent sees
  the graph symbols matching its search next to the tool's own result, from its own project's graph only, worktree
  chats included. The hook never blocks a tool: an error or a 4-second timeout just adds nothing.
  - **Claude Code** gets `--settings` hooks before each Grep, Glob or Bash search, and after each Read (what the graph
    could not parse in that file).
  - **Codex** gets an inline `-c hooks.PreToolUse` hook before its shell commands (`rg`, `grep`, ...). Codex runs only
    hooks a person trusted in `/hooks`, so the turn gets `--dangerously-bypass-hook-trust`, which runs *every* enabled
    hook unreviewed for that turn: the account's own (`CODEX_HOME`, yours) and a repository's `.codex/` hooks if Codex
    loads them. A turn whose folder or project folder has `.codex/hooks.json` or hooks in `.codex/config.toml` therefore
    gets no hook from Dalang (and no bypass). Codex 0.162.1 was checked. Dalang reads `codex exec --help` once
    (restart it after updating Codex): a Codex that does not know the flag gets no hook rather than a failed turn.

### SQL editor

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
  the first error (the results before it stay). A statement returns at most the row limit (100 to 10 000; the rest is
  never fetched) and stops after two minutes; **Cancel** stops it sooner (PostgreSQL `pg_cancel_backend`, MySQL/MariaDB
  `KILL QUERY`; SQLite runs to the end). `Shift Alt F` formats the selection or the console (sql-formatter). **History**
  lists the last 300 runs of this browser, to insert or run again. Results stay in tabs below the console: a query
  on another table adds a tab, one on the same table (or the same query again) refreshes its tab, and statements
  that return no rows share an **Output** tab (at most 12 tabs; the oldest go). The maximize button (or
  `Ctrl Shift '`) shows only the results, full screen (the browser's own full screen where it allows it); `Esc`
  brings the rest back. A result's rows (those it holds, up to the row limit) copy or download as CSV (with a BOM, so
  Excel reads UTF-8), TSV, Excel (`.xlsx`, header bold and frozen), JSON, JSON Lines, SQL `INSERT` statements (for the
  result's table, in the connection's dialect), a Markdown or an HTML table; the download asks for a file name
  (the tab's and the time, to change). Consoles are kept in the browser. Every run opens its own connection, so a
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

### MongoDB and Redis in the SQL editor

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

### Databases behind an SSH server

A connection (any engine but SQLite) can go through an SSH tunnel: tick **Connect through an SSH tunnel** and give the
SSH host, port (22 if empty), user, and a password or a private key (paste its text or **Load a key file**; a
passphrase if it has one). The database's host and port are then as the SSH server sees them, often `localhost`. The
host field cannot hold a URI then. A tunnel is opened for each query, tree read or test and closed after it; TLS to
the database still checks the database's own name.

The SSH server's key is trusted on first use: **Test connection** shows its fingerprint (`SHA256:...`) and **Save**
trusts it. From then on a server with another key is refused until the connection is tested and saved again (for a
reinstalled server); changing the SSH host or port forgets the trusted key. SSH passwords, keys and passphrases are
stored like the database password and never sent back to the browser.

## Develop

`LZVR_TOKEN=<32+ chars> WORKSPACE_ROOT=. npm run dev`, `npm test`, `npm run typecheck`.

On native Windows, `run.cmd` (or `scripts\run.ps1`) does it in one go: checks Node, runs `npm ci` when the lockfile
changed, writes `.env` from `.env.example` with a fresh `LZVR_TOKEN` on the first run, finds `codex.exe`, `claude.exe`,
`gh.exe` and `glab.exe` when `.env` does not set `CODEX_BIN` / `CLAUDE_BIN` / `GH_BIN` / `GLAB_BIN`, then builds and
starts. `run.cmd -Dev` runs `src/main.ts` through tsx without building; `-Install` forces `npm ci`.

To keep it running in the background from every logon, `autostart.cmd install` registers a `Dalang` Task Scheduler
task that runs `scripts\run.ps1` hidden, logging to `state\autostart.log`. After an update, `autostart.cmd restart`
pulls (`--ff-only`; `-NoPull` skips it), stops the task, frees the port and starts it again, which rebuilds. Also
`stop`, `status` and `uninstall`. Don't run `restart` or `stop` from a Dalang chat: it stops the server running it.

The panel (`public/`) has no build step: Preact components written with htm tagged templates, state in
`@preact/signals`. Its libraries and fonts are copied from `node_modules` into `public/vendor` and `public/fonts` by
`npm run vendor` (run it after updating one of them); bare imports are rewritten to relative ones there, since the CSP
allows no inline import map. The code editor's CodeMirror and xterm.js are the exception: many small packages, so
`npm run vendor` bundles them with esbuild into `public/vendor/code` (`scripts/code-editor.entry.mjs` lists what is
used; each language is its own chunk, loaded when a file of it opens). The editor's page is the same shell under `/code`,
whose CSP also allows inline styles (both libraries write `<style>` elements); the rest of the panel stays strict.
Colours come from Radix Colors scales (Settings → Appearance switches the accent palette).

## Scope

Built: core gateway, multi-account failover, panel + PWA + Web Push, MCP gateway.
Dropped: Docker-in-Docker test sandbox (the gateway runs directly on the VM).
Not verified against the real services in development: the real Codex limit message and cross-account resume, push
in a real browser/phone, and the panel UI in a browser (all were tested with fakes or unit tests).
