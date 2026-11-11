# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project memory: facts kept per project from its chats and shown to every later chat on Codex and Claude Code
  alike. They stay when the chat they came from is deleted. After each finished turn a small read-only request picks
  what is worth keeping (Settings → Project memory, `AUTO_MEMORY=0` turns it off); agents get `memory_search`,
  `memory_save`, `memory_update` and `memory_forget`, and people a memory button in the chat header. Each person also
  has a memory of their own preferences, shown to every turn they send in any project and seen by them alone
- Restarts no longer cut running chats off: on SIGTERM (`scripts/update.sh`) or `autostart.cmd restart` on
  Windows, running turns get `DRAIN_MINUTES` (default 5) to finish while the panel stays up and new prompts wait in
  their queue; a turn still running then continues in its session after the restart. `update.sh` adds a systemd
  drop-in with `KillMode=mixed` and `TimeoutStopSec=10min` for it
- ClickUp messages agents ask to send wait for the owner's approval: a card in the chat and in Approvals shows the
  workspace, the channel or person and the thread replied to, and the owner may change the text before sending.
  Agents can message a person privately (`to_user_id`), pick a thread with `clickup_list_threads`, find people with
  `clickup_find_people` and follow a request with `clickup_send_status`

### Fixed

- On Node 22 and 24, a panel user's git identity could carry over into the owner's later git requests, so the
  owner's commits failed with "empty ident name"; each request now gets only its own git context
- Panel users other than the owner saw "Not a git repository" in the Changes tab of projects owned by another OS
  account: their own git config dropped the server's `safe.directory`, which is now passed on to them
- A Merge Request whose target branch was changed on GitHub or GitLab kept the old one in the panel (commits ahead,
  the description, syncing the base); the chat now follows the branch the forge says it goes into while it is open
- A Claude Code turn whose CLI did not exit after its answer, or whose CLI died while a program it started kept its
  output open, left the chat "running" for good; both now end by themselves
- A crash or reboot lost the prompt that was running; it now continues once in its session after the restart. A
  restart no longer runs a turn again that had just finished
- A chat a person stopped is no longer started again by a sub-agent's or Reviewer's late report: the report waits
  for the person's next prompt
- Several `create_conversation` calls at once could go over the limit of sub-agents
- A turn no longer waits without limit for the code graph: after 10 minutes it runs on the previous one
- Schedules fired on every tick during the hour that repeats when clocks go back

### Security

- The code editor could write into `.git` through another spelling of it on Windows (`.GIT`) or a symlink
- The statements agents are refused on a database (`COPY ... PROGRAM`, `pg_read_file`, `INTO OUTFILE`, `$where`)
  passed when written with comments, quoted names or escapes; panel users other than admins get the same refusals
  on a read-only connection
- Test connection sent the saved password to an SSH server whose key had changed; a changed key now has to be
  accepted first. Saved passwords of a database connection are kept only for the server they were saved for
- Sign-in codes: an email takes 20 wrong codes a day, and a used-up code keeps its cooldown
- A session of an owner email ends when the email leaves `LZVR_OWNER_EMAILS` or `LZVR_TOKEN` changes. Owners signed
  in by email sign in once more after this update
- Web Push is sent only to the browsers' push services (Chrome, Firefox, Safari, Edge), 10 subscriptions per user;
  a subscription stored for another address is removed
- `AUTH_BYPASS` is refused together with `TRUST_PROXY`; `TERMINAL_USER` may not be in docker, lxd, incus, disk or
  libvirt; the Reviewer gets read-only MCP tools; a token written into a remote's URL is no longer shown in the panel

## [0.1.0] - unreleased

First version: a self-hosted control room for the Codex CLI and Claude Code.

### Added

- Projects with parallel chats, each with its own agent session, draft and prompt queue; live view over SSE
- Optional worktree per chat on its own `dalang/<id>` branch
- Changes inspector: diffs, commit and push, hunks, stashes, conflicts, amend and undo, history graph, compare,
  cherry-pick, revert, tags, agent checkpoints, and Merge Requests through `gh` / `glab`
- Code editor with file tree, search, command palette and terminals
- Scheduled prompts (cron)
- Failover between your own Codex and Claude Code accounts on usage limits
- Email sign-in with one-time codes, users and roles, installable PWA and Web Push
- MCP gateway at `/mcp` for driving chats and sub-agents, ClickUp Chat history, and other MCP servers
- Code memory: a code graph per project, queried by agents through `/mcp`
- SQL editor for PostgreSQL, MySQL, MariaDB, SQLite, MongoDB and Redis, optionally through SSH tunnels
- SSH hosts for agents, with stored secrets encrypted with AES-256-GCM
- Dalang's own skills for chat agents, starting with diagram design

[Unreleased]: https://github.com/luzyver/lzvr-dalang/commits/master
