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

### Fixed

- On Node 22 and 24, a panel user's git identity could carry over into the owner's later git requests, so the
  owner's commits failed with "empty ident name"; each request now gets only its own git context
- Panel users other than the owner saw "Not a git repository" in the Changes tab of projects owned by another OS
  account: their own git config dropped the server's `safe.directory`, which is now passed on to them

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
