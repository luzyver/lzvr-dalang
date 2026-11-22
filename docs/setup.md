# Setup and administration

Install and administer the server. For a local quick start, see the [README](../README.md#quick-start);
for development, see [CONTRIBUTING](../CONTRIBUTING.md).

- [Installation and updates](#install-on-the-vm-no-docker), or [with Docker](#install-with-docker)
- [Terminals](#terminals-without-root) and [HTTPS](#nginx-https)
- [Sign-in](#signing-in), [users](#users), [accounts](#adding-codex-accounts)
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

## Install with Docker

Instead of systemd: `Dockerfile` and `compose.yaml` in this repo run Dalang in one container, with the `codex` and
`claude` CLIs, git, ssh and `gh` inside it. Needs Docker with Compose v2.

```bash
git clone https://github.com/luzyver/lzvr-dalang.git /opt/lzvr-dalang && cd /opt/lzvr-dalang
cp .env.example .env                                   # set LZVR_TOKEN (openssl rand -hex 32) and the sign-in mail
mkdir -p projects                                      # or point PROJECTS_DIR at the folder that holds your projects
# the account that owns the project folders (here: deploy), never root: the build refuses uid or gid 0
DALANG_UID=$(id -u deploy) DALANG_GID=$(id -g deploy) docker compose up -d --build
docker compose exec dalang bwrap --unshare-user --unshare-pid --ro-bind / / --dev /dev true && echo sandbox ok
```

The panel is then on `http://127.0.0.1:9876` of the host (loopback only). What differs from the VM install:

- **Settings in `.env`** as in "Configuration", but `HOST`, `PORT`, `STATE_DIR` and `WORKSPACE_ROOT` are set by
  `compose.yaml` and win over it. `DALANG_PORT` (the host's port), `PROJECTS_DIR`, `DALANG_UID` and `DALANG_GID` are read
  by Compose itself: put them in `.env` too, so a later `docker compose up` does not need them on the command line.
  `AUTH_BYPASS` stops the start here, since the container does not listen on loopback.
- **Projects** are the host folder `PROJECTS_DIR` (default `./projects`), seen in the container as `/workspace`: add
  a project in the panel as `/workspace/<folder>`. Agents see nothing else of the host.
- **Everything runs as the user `node`**, not root, with the uid and gid given at build time (`DALANG_UID`,
  `DALANG_GID`, default 1000). Use those of the owner of the project folders, or agents cannot write there and git calls
  the repositories "dubious". From a root shell `$(id -u)` is 0, which the build refuses: name the account, and
  `chown -R` the project folders to it if root owns them. Agents cannot install system packages; add what your
  projects need to the `Dockerfile`.
- **Codex's sandbox** (bubblewrap) makes namespaces of its own, which Docker's default seccomp and AppArmor profiles
  refuse, so `compose.yaml` turns both off for this container (`security_opt`); no capability is added. The last
  command above checks it as the container's user: without "sandbox ok", every command of a Codex chat in a
  `read-only` or `workspace-write` project fails, the Reviewer's too. On a host that restricts user namespaces
  (Ubuntu 24.04 and later) also run `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` there, and keep it in
  `/etc/sysctl.d`. With `docker run`, pass `--security-opt seccomp=unconfined --security-opt apparmor=unconfined`.
- **What is kept**: the volume `state` (database, accounts, uploads, worktrees) and the volume `home` (the home of
  `node`: `~/.gitconfig`, `~/.ssh`, the `gh` login, so Settings → Git & forges works as on a VM). Back up both;
  `docker compose down -v` deletes them.
- **nginx** runs on the host as in the next sections, with `nginx.conf` unchanged. The container sees it come from the
  network's gateway, so set `TRUST_PROXY=172.31.98.1` (not `1`) next to `LZVR_ORIGIN`; `compose.yaml` fixes that
  subnet, change both if it is taken on your host.
- **Terminals** in the code editor are the owner's only: `TERMINAL_USER` needs a service running as root.
- **`gh` and `glab`** are in the image (`glab` pinned by `GLAB_VERSION` and its hashes in the `Dockerfile`), so Merge
  Requests and HTTPS logins work for GitHub and GitLab. A self-hosted forge whose host name contains neither word
  (`git.example.com`) also needs `GIT_FORGE` in `.env` (see "Merge Requests: gh and glab").
- **`php`** (the CLI of Debian bookworm, PHP 8.2) is in the image, so agents can check the syntax of the PHP files they
  change with `php -l`. It is not the PHP version of your servers: code that only an older PHP accepts may be reported
  as an error.
- **`python3`** (Debian bookworm's Python 3.11, also as `python`) with `pip` and `venv` is in the image, for the
  scripts agents write and for Python projects. Debian marks its Python as externally managed, so packages go in a
  virtual environment (`python -m venv .venv`), not system-wide.
- **Databases and SSH hosts on the Docker host itself** are not `127.0.0.1` from inside the container: use the gateway
  address (`172.31.98.1`) or the host's own address.

To update: `git pull --ff-only && docker compose up -d --build`. The CLIs are installed at their latest version when
that layer is built; `docker compose build --no-cache` moves them (or pin `CODEX_VERSION` / `CLAUDE_CODE_VERSION` in
the `Dockerfile`). Stopping or replacing the container lets running chats finish first, as on the VM: `init: true`
signals node alone and `stop_grace_period` (10 minutes) waits for it; raise it with a longer `DRAIN_MINUTES`. Don't
update from a Dalang chat: it stops the server running that chat.

### Continuous deployment

`.github/workflows/deploy.yml` redeploys a Docker install whenever CI passes on a push to `master` (merging a pull
request is one), and from the Actions tab (**Deploy → Run workflow**). It logs in with an SSH key that can do one thing:
run `dalang-deploy <sha>` (`scripts/deploy-docker.sh`), which fast-forwards the checkout to that commit, builds the
image while the old container keeps serving, swaps the container and waits for it to be healthy. A commit that is not on
`origin/master`, a failed build or an unhealthy container fails the job; the first two leave the running container alone.

On the server, as the account that owns the checkout (here `deploy`), with sudo:

```bash
sudo install -m 755 scripts/deploy-docker.sh /usr/local/bin/dalang-deploy
echo 'deploy ALL=(root) NOPASSWD: /usr/local/bin/dalang-deploy' | sudo tee /etc/sudoers.d/dalang-deploy
sudo chmod 440 /etc/sudoers.d/dalang-deploy && sudo visudo -cf /etc/sudoers.d/dalang-deploy
ssh-keygen -t ed25519 -N '' -C dalang-deploy -f dalang-deploy        # the private half goes to GitHub, then delete it
echo "restrict,command=\"sudo -n /usr/local/bin/dalang-deploy \\\"\${SSH_ORIGINAL_COMMAND:-}\\\"\" $(cat dalang-deploy.pub)" \
  >> ~/.ssh/authorized_keys
ssh-keyscan -t ed25519 panel.example.com                             # -> DEPLOY_KNOWN_HOSTS
```

In the repository's **Settings → Secrets and variables → Actions**: variables `DEPLOY_HOST` (and `DEPLOY_USER` unless it
is `deploy`, `DEPLOY_PORT` unless 22), secrets `DEPLOY_SSH_KEY` (the private key) and `DEPLOY_KNOWN_HOSTS` (the
`ssh-keyscan` line). Without `DEPLOY_HOST` the workflow skips, so forks are not affected. The server must accept SSH from
GitHub's runners.

- `/usr/local/bin/dalang-deploy` is a copy, so a push cannot change what the key may run: reinstall it when the script
  changes. A push can still change `Dockerfile` and `compose.yaml`, which run as root through Docker: whoever may push to
  `master` controls the server. Protect the branch.
- Keep `stop_grace_period` (in `compose.yaml`, or a `compose.override.yaml` next to it) longer than `DRAIN_MINUTES`;
  the job allows 45 minutes for a deploy.
- Local commits in the server's checkout stop the deploy (it only fast-forwards). Keep server-only settings in `.env`
  and `compose.override.yaml`.

## Terminals without root

The service runs as root, so a terminal in the code editor would be a root shell. That one is for the owner alone
(the main token, or a sign-in with an owner email). Other users get terminals only with `TERMINAL_USER`, and
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

Then `Environment=TERMINAL_USER=dalang` in the service and restart it. Every new terminal of anyone but the owner then:

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
Approval notifications go to the users who may open what the approval is about. Signing out removes the device's subscription. Old subscriptions
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

## Users

The main access token (`LZVR_TOKEN`) is the **owner**, and the break-glass login if everything else goes wrong. Open
**Users** in the panel to create people. Users have no roles: every user may do everything in the panel (add and
delete projects, add accounts, manage users, connections and SSH hosts, decide approvals) except what is the owner's
alone: the server's git setup, MCP servers, root terminals, and whatever a project,
connection or host with **Owner only** access holds. What a user sees is set per project, database connection and SSH
host, so create users only for people you would trust with the server.

Each user has an email (set when creating them, editable in the list): that is what they sign in with. Creating a user also
prints a personal API token **once** (only a hash is stored), for the HTTP/MCP API or signing in without email. **New token** replaces a user's token and signs
out all their sessions; **Delete** removes their token and sessions at once. Over `/mcp`, the available tools depend on
the enabled integrations.

Each project has an **access** setting, picked when it is added and changeable from its menu in the sidebar (**Access…**):

| Access | Who may open it |
|---|---|
| Everyone (`all`, the default) | the owner and every user |
| Selected users (`owner` plus `members`) | the owner and the users ticked in the dialog; with none ticked, the owner only |

A user can only save a choice that still includes themselves; the owner can save any. A deleted user leaves these lists.

The owner always sees every project. Anyone else gets a 404 for a project they may not open, its chats and everything in
them (git, files, terminals, schedules, queue, approvals), and does not find it in lists, search or over `/mcp`. An agent sees
the projects of the user who sent its turn's prompt (plus its own); one with no such user sees only `all` projects (plus its
own). Note that anyone chatting in a project whose sandbox is `danger-full-access` is effectively running commands as
the server's user (root, if the service runs as root), so share such projects only with people you trust.

**Upgrading from roles (admin / dev):** every user now has what admins had. A project that was for "Owner and admins"
becomes one shared with the users who were admins then, by name. Database connections, SSH hosts and SSH keys that
were for "Owner and admins" become **Everyone**: set them to **Owner only** if they should not be.

An upload waiting to be attached is private to its uploader and the owner. Once attached, downloading or reusing it
requires access to at least one project it was attached to; current project permissions apply even to the original
uploader. Upgrades recover these links from chat history and queued prompts. Legacy files with no such record remain
owner-only; upload them again if another user needs them.

## Adding Codex accounts

Every Codex account is added from the panel, including the first one. Dalang starts with no account (and never reads
`~/.codex`); the first time someone opens the panel it goes straight to the sign-in step. Click **+ Account**, type a name,
press **Start login**. The gateway runs `codex login --device-auth` on the VM and shows a sign-in link and a code. Open the
link on any device, enter the code and approve with the Codex/ChatGPT account you want to add. When Codex reports that
account as logged in it joins the failover list (in the order added), survives restarts, and its folder is
`<STATE_DIR>/codex-accounts/<name>`, so backing up `STATE_DIR` backs up all of them. The first account's `sessions`
folder is shared with the later ones so a chat can move between accounts. Until an account exists, chats fail with a
message saying to add one.

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

Only the owner (main token or owner sign-in) works with the server's git setup above. Every other panel user
has their own under `<STATE_DIR>/git-users/<user id>/`, managed in their own **Settings → Git & forges**:

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
  every project on this Dalang whose host name says neither, and never overrides a name that does (a `github.com`
  remote goes to `gh` even with `GIT_FORGE=gitlab`).
- **SSH aliases work.** A remote like `git@github.com-work:acme/app.git` (one key per account in `~/.ssh/config`) is
  resolved with `ssh -G` to the real host, and the CLI is told the repository explicitly (`gh --repo github.com/acme/app`,
  `glab --repo https://gitlab.example.com/group/sub/app`), since neither CLI knows such aliases. Subgroups work.
- **Nothing is asked.** `gh` runs with `GH_PROMPT_DISABLED=1`, `glab` with `--yes` and `GLAB_NO_PROMPT=1`. Dalang pushes the
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
| `LZVR_SECRET_KEY` | `<STATE_DIR>/secret.key` | Encrypts the passwords, keys and tokens stored in the database (see "Security"). Use a long random value (`openssl rand -base64 32`); keep it, since without it they cannot be read. |
| `HOST` / `PORT` | `127.0.0.1` / `9876` | Listen address. Keep loopback and put a TLS proxy in front. |
| `TRUST_PROXY` | off | Set `1` when a reverse proxy **on this machine** (nginx/Caddy) fronts the gateway, or list its IPs/CIDRs (`10.0.0.5,10.0.1.0/24`). Rate limiting then uses the client address that proxy saw. Without it, every visitor looks like `127.0.0.1` and ten bad tokens from anyone lock everyone out. Never trust addresses that are not your proxy. |
| `LZVR_ORIGIN` | unset | Full `https://` origin of the panel; the Web Push contact when `LZVR_VAPID_SUBJECT` is unset, and where a ClickUp sign-in comes back to. |
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
| `GIT_FORGE` | from the remote | `github` or `gitlab`, for a self-hosted server whose host name contains neither word. A host name that does contain one wins over it. |
| `TERMINAL_SHELL` | PowerShell / login shell | The shell the code editor's terminals start (a path, no arguments). |
| `TERMINAL_USER` | unset | Linux: the account the code editor's terminals of users other than the owner run as (the owner's run as the service's). Unset, only the owner has terminals. It may not be root or able to use sudo, and its shells can never gain rights (see "Terminals without root"). |

## Security

`WORKSPACE_ROOT=/` plus a project with `"sandbox": "danger-full-access"` means the token is a root shell: keep the
panel off the public internet (Tailscale/WireGuard/IP allowlist, or TLS proxy), and snapshot the VM first.
Ten wrong tokens from one address in a minute are blocked with 429. Everything Codex reads is sent to OpenAI as
context, so keep secrets (`.env`, keys) out of the folders you register, or use `"sandbox": "read-only"` and
a narrower `WORKSPACE_ROOT` (for example `/var/www`).

**Secrets in the database are encrypted.** SSH hosts, SQL editor connections (and their SSH tunnels), the ClickUp
connections, other MCP servers' tokens and environment, and the push key are stored with AES-256-GCM, so `lzvr.db` alone (a
copy, a backup, an agent reading it) does not give them away. The key is `LZVR_SECRET_KEY`, which no agent, terminal
or git process Dalang starts receives (no `LZVR_*` variable does). Without it, Dalang makes `<STATE_DIR>/secret.key`
and warns at start: that file sits next to the database, so for agents that can read the state folder, put its content
in `LZVR_SECRET_KEY` (the systemd unit's `Environment=` or `.env`) and delete the file. The key is hashed once with SHA-256, not stretched, so a chosen
word or phrase can be guessed from a copy of the database: use a random one (`openssl rand -base64 32`). Values stored in clear by an
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
