# Security policy

Dalang runs AI agents with shell access on your own machine, so its security model matters more than most web apps'.
Read the [Security](docs/setup.md#security) section of the setup documentation before exposing a panel.

## Supported versions

Only the latest commit on `master` receives fixes. Update with `git pull` (or `autostart.cmd restart` /
`scripts/update.sh`) before reporting.

## Reporting a vulnerability

Please report privately through
[GitHub security advisories](https://github.com/luzyver/lzvr-dalang/security/advisories/new). Do not open a public
issue or pull request.

Include what an attacker needs (network position, a panel account and its role, an agent's access), the steps, and
the impact. You can expect an acknowledgement within a few days and a fix or an explanation of the decision after
that; credit is given in the advisory unless you prefer otherwise.

## In scope

- Authentication and session handling: sign-in codes, `LZVR_TOKEN`, rate limiting, `AUTH_BYPASS` restrictions
- Authorization between users and roles, projects and chats, including through `/mcp`
- Escapes from `WORKSPACE_ROOT`, a project's `read-only` mode, or a chat's worktree
- Exposure of stored secrets (SSH hosts, database connections, MCP tokens, the push key) or of `LZVR_*` variables
  to agents, terminals or git processes
- XSS or CSP bypasses in the panel, CSRF, SSRF through MCP, database or SSH features

## Out of scope

- What an agent does with the access it was given: a project with `danger-full-access` or a Claude Code project in
  `workspace-write` can run anything as the service's OS user, by design
- Agents running as the same OS user reading Dalang's service file or process environment (documented; run agents as
  another user to prevent it)
- Data sent to OpenAI or Anthropic as model context
- Panels exposed to the internet without TLS, or deployments ignoring the guide
