# syntax=docker/dockerfile:1
# Dalang in a container (see "Install with Docker" in docs/setup.md). Debian, not Alpine: the terminals' node-pty
# ships glibc binaries only.

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    --mount=type=cache,target=/root/.npm \
    npm ci
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.source=https://github.com/luzyver/lzvr-dalang \
      org.opencontainers.image.description="Self-hosted control room for the Codex CLI and Claude Code" \
      org.opencontainers.image.licenses=MIT

# What the agents and the panel run: git and ssh (Changes, pushes, SSH tests), gh (Merge Requests on GitHub; glab for
# GitLab is installed below), and the tools agents reach for first in a project. bubblewrap is Codex's sandbox on Linux
# (it needs the security_opt lines of compose.yaml to make its namespaces). libreoffice-writer turns a filled @template .docx into a PDF (soffice --headless),
# with fonts-liberation and fonts-dejavu-core so the text has glyphs. php-cli is for agents working on PHP projects: a
# syntax check (php -l) of the files they changed.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client ripgrep less procps bubblewrap \
       libreoffice-writer fonts-liberation fonts-dejavu-core php-cli \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh

# glab (Merge Requests and HTTPS logins on GitLab, Settings -> Git & forges): not packaged by Debian bookworm, so the
# release .deb from gitlab.com, checked against the hashes pinned here. To move it, change GLAB_VERSION and both hashes
# (checksums.txt of that release: https://gitlab.com/gitlab-org/cli/-/releases).
ARG GLAB_VERSION=1.128.0
ARG GLAB_SHA256_AMD64=b42db1c339cb66df2dbdaf190b8c4e359cb2ea3f7ac53e46302b04777f2cf405
ARG GLAB_SHA256_ARM64=88e68a179fc25c3751e7950aa4b1b47b184cade590b70d9ca4aafff6648c655e
RUN arch=$(dpkg --print-architecture) \
    && case "$arch" in \
         amd64) sha="$GLAB_SHA256_AMD64" ;; \
         arm64) sha="$GLAB_SHA256_ARM64" ;; \
         *) echo "no glab package for $arch" >&2; exit 1 ;; \
       esac \
    && deb="glab_${GLAB_VERSION}_linux_${arch}.deb" \
    && curl -fsSL -o "/tmp/$deb" "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/$deb" \
    && echo "$sha  /tmp/$deb" | sha256sum -c - \
    && dpkg -i "/tmp/$deb" \
    && rm "/tmp/$deb" \
    && glab version

# The agent CLIs. `latest` at build time: rebuild with --no-cache (or pin a version here) to move them.
ARG CODEX_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
RUN --mount=type=cache,target=/root/.npm \
    npm install -g "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Everything runs as `node`, not root. Give it the uid and gid that own your project folders on the host
# (--build-arg DALANG_UID=... --build-arg DALANG_GID=...), so agents can write there. Never 0: `node` would then be
# root under another name (a build from a root shell with $(id -u) gives exactly that), so the build stops.
ARG DALANG_UID=1000
ARG DALANG_GID=1000
RUN if ! [ "${DALANG_UID}" -gt 0 ] || ! [ "${DALANG_GID}" -gt 0 ]; then \
      echo "DALANG_UID and DALANG_GID must be those of an account other than root (got ${DALANG_UID}:${DALANG_GID})" >&2; exit 1; \
    fi \
    && groupmod -o -g "${DALANG_GID}" node && usermod -o -u "${DALANG_UID}" -g "${DALANG_GID}" node \
    && mkdir -p /data/state /workspace \
    && chown -R "${DALANG_UID}:${DALANG_GID}" /data /workspace /home/node

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY skills ./skills
COPY scripts/agent-git-hooks ./scripts/agent-git-hooks
COPY scripts/code-memory-hook.mjs ./scripts/
RUN chmod +x scripts/agent-git-hooks/*

# HOST: the container's own interfaces; publish the port on the host's loopback only (compose.yaml does).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=9876 \
    STATE_DIR=/data/state \
    WORKSPACE_ROOT=/workspace \
    DISABLE_AUTOUPDATER=1

USER node
EXPOSE 9876
VOLUME ["/data/state", "/home/node"]
# The panel's shell needs no sign-in: it answers once the server is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Run it with an init (compose.yaml: `init: true`; docker run --init): node then is not pid 1, what the agents leave
# behind is reaped, and a stop signals node alone, which lets running chats finish (DRAIN_MINUTES).
ENTRYPOINT ["node", "dist/main.js"]
