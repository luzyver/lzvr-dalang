<div align="center">

<img src="public/icon.svg" width="84" alt="Dalang logo">

# Dalang

**The puppeteer behind the screen.**<br>
A self-hosted control room for **Codex CLI** and **Claude Code** agents: a web panel you can install on your phone,<br>
and an HTTP/MCP API, running agent sessions on your own machine.

[![CI](https://github.com/luzyver/lzvr-dalang/actions/workflows/ci.yml/badge.svg)](https://github.com/luzyver/lzvr-dalang/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)
![Preact](https://img.shields.io/badge/Preact-no%20build%20step-673AB8?logo=preact&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-gateway-5b5bd6)
![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8?logo=pwa&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Quick start](#quick-start) · [Guide](docs/guide.md) · [Install](docs/guide.md#install-on-the-vm-no-docker) · [MCP API](docs/guide.md#mcp) · [Contributing](CONTRIBUTING.md)

<br>

<img src="docs/screenshots/hero.png" alt="Dalang: a chat with an agent's steps and answer, the Changes inspector with a commit ready, and the same chat on a phone" width="100%">

</div>

<br>

lzvr-dalang (the panel calls itself Dalang) runs headless `codex exec` and `claude` sessions on your own VM, streams
what they do into the panel, and fails over between your own accounts when one hits its usage limit. Part of the
`lzvr` toolbox (environment variables are `LZVR_*`).

## Highlights

<table>
<tr>
<td width="33%" valign="top">

**Parallel chats per project**<br>
Each chat has its own agent session, draft and prompt queue, optionally in its own git worktree.

</td>
<td width="33%" valign="top">

**Live view**<br>
Commands, file edits, reasoning and answers stream in over SSE, on desktop or phone.

</td>
<td width="33%" valign="top">

**Git without leaving the chat**<br>
Diffs, hunks, commit and push, stashes, conflicts, history, checkpoints and Merge Requests.

</td>
</tr>
<tr>
<td valign="top">

**Account failover**<br>
A usage limit moves the same turn to your next Codex or Claude Code account and resumes it.

</td>
<td valign="top">

**MCP gateway**<br>
Other agents drive chats through `/mcp`; a chat's agent can start sub-agents and hear back.

</td>
<td valign="top">

**Code editor and terminals**<br>
CodeMirror editor, file tree, search and terminals in the folder each chat works in.

</td>
</tr>
<tr>
<td valign="top">

**SQL editor**<br>
PostgreSQL, MySQL, MariaDB, SQLite, MongoDB and Redis, with per-connection agent access.

</td>
<td valign="top">

**Scheduled prompts**<br>
Cron schedules that keep a conversation going, with a push notification when each run ends.

</td>
<td valign="top">

**Safe by default**<br>
Email codes, users and roles, read-only projects, approvals, and secrets encrypted at rest.

</td>
</tr>
</table>

## Screenshots

<table>
<tr>
<td width="50%"><img src="docs/screenshots/diff.png" alt="Side-by-side diff of an agent's change, with a checkbox per hunk"><p align="center"><sub><b>Review every hunk</b> before it is committed</sub></p></td>
<td width="50%"><img src="docs/screenshots/code-editor.png" alt="Code editor with a file tree and the file the agent created"><p align="center"><sub><b>Code editor</b> on the chat's own folder</sub></p></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/sql-editor.png" alt="SQL editor with a query and its result grid"><p align="center"><sub><b>SQL editor</b> with a result grid and agent access per connection</sub></p></td>
<td width="50%"><img src="docs/screenshots/light-mode.png" alt="The chat view in light mode"><p align="center"><sub><b>Light and dark</b>, with switchable accent palettes</sub></p></td>
</tr>
<tr>
<td colspan="2" align="center"><img src="docs/screenshots/mobile.png" alt="The panel on a phone: home screen and a chat" width="60%"><p align="center"><sub><b>Installable on your phone</b>, with Web Push when a turn finishes or needs you</sub></p></td>
</tr>
</table>

<sub>Screenshots use a demo instance with sample projects; names and data are made up.</sub>

## Quick start

Try it locally (Node 22.13 or newer, and the `codex` or `claude` CLI on PATH):

```bash
git clone https://github.com/luzyver/lzvr-dalang.git && cd lzvr-dalang
npm ci
cp .env.example .env    # set LZVR_TOKEN (openssl rand -hex 32), WORKSPACE_ROOT, and AUTH_BYPASS=true for local use
npm run dev             # http://127.0.0.1:9876
```

Open the panel, add a Codex or Claude Code account in Settings, add a project folder and start a chat. On Windows,
`run.cmd` does all of this in one go (see [Develop](docs/guide.md#develop)). For a real server, follow
[Install on the VM](docs/guide.md#install-on-the-vm-no-docker): systemd, nginx with HTTPS, and email sign-in.

## Documentation

The full guide is in **[docs/guide.md](docs/guide.md)**:

| | |
| --- | --- |
| [Features](docs/guide.md#features) | Projects, worktrees, Changes and git, code editor, schedules, failover, push, MCP, SQL editor, Claude Code |
| [Install on the VM](docs/guide.md#install-on-the-vm-no-docker) | systemd, terminals without root, nginx with HTTPS, sign-in, users and roles, accounts |
| [Configuration](docs/guide.md#configuration) and [security](docs/guide.md#security) | Environment variables, what the token grants, encrypted secrets |
| [Use without the panel](docs/guide.md#use-without-the-panel) | HTTP API, MCP gateway, ClickUp, other MCP servers, agents and git |
| [SQL editor](docs/guide.md#sql-editor) and [SSH hosts](docs/guide.md#ssh-hosts-for-agents) | Connections, agent access, SSH tunnels, approvals |
| [Develop](docs/guide.md#develop) | Running from source, the panel without a build step, vendored libraries |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and commit style, [SECURITY.md](SECURITY.md) to report a
vulnerability, and [CHANGELOG.md](CHANGELOG.md) for notable changes.

## License

[MIT](LICENSE) © luzyver. Bundled third-party code keeps its own license: the browser libraries and fonts in
`public/vendor` and `public/fonts` (see [public/vendor/README.md](public/vendor/README.md)), the Lucide icons in
`public/icons` ([public/icons/LICENSE](public/icons/LICENSE)), and the diagram-design skill
([skills/diagram-design/LICENSE](skills/diagram-design/LICENSE)).
