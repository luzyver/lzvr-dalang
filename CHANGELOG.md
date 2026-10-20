# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
