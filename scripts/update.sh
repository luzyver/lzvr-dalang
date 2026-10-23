#!/usr/bin/env bash
# Updates Dalang on the server and restarts its systemd service (see "Install on the VM" in docs/guide.md).
# Usage, from the checkout on the server: scripts/update.sh [--no-pull]
#   git pull --ff-only, npm ci when the lockfile changed, build, systemctl restart, then wait for the port.
#   The restart lets running chats finish first (up to DRAIN_MINUTES, default 5); one still running then is resumed after it.
#   A failed pull or build leaves the running service alone. SERVICE overrides the unit name (default lzvr-dalang).
# From another machine: ssh server 'cd /opt/lzvr-dalang && scripts/update.sh'. Do not run it from a Dalang chat: the
# restart stops the server running that chat.
set -euo pipefail
cd "$(dirname "$0")/.."
service=${SERVICE:-lzvr-dalang}

fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
info() { printf '\033[36m%s\033[0m\n' "$*"; }
SUDO=; [ "$(id -u)" -eq 0 ] || SUDO=sudo

systemctl cat "$service" >/dev/null 2>&1 || fail "No $service service: set it up first (docs/guide.md, \"Install on the VM\")."

# PORT from the unit's Environment=, then .env, then the default.
port=$(systemctl show -p Environment --value "$service" | tr ' ' '\n' | sed -n 's/^PORT=//p' | tail -n1 || true)
[ -n "$port" ] || port=$(sed -nE 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*["'\'']?([0-9]+).*/\1/p' .env 2>/dev/null | tail -n1 || true)
port=${port:-9876}

if [ "${1:-}" != --no-pull ]; then
  info 'git pull --ff-only...'
  git pull --ff-only || fail "git pull failed: $service was left running."
fi
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  info 'Installing dependencies (npm ci)...'
  npm ci || fail "npm ci failed: $service was left running."
else
  info 'package-lock.json unchanged, skipping npm ci.'
fi
info 'Building (tsc)...'
npm run build --silent || fail "Build failed: $service was left running."

# The drain needs systemd to signal only node (KillMode=mixed: with the default the agents get the SIGTERM too and die)
# and to wait for it (TimeoutStopSec, longer than DRAIN_MINUTES). A drop-in sets both once; edit it for a longer drain.
dropin=/etc/systemd/system/$service.service.d/drain.conf
if [ ! -f "$dropin" ]; then
  info "Adding $dropin (KillMode=mixed, TimeoutStopSec=10min)..."
  $SUDO mkdir -p "$(dirname "$dropin")"
  printf '[Service]\nKillMode=mixed\nTimeoutStopSec=10min\n' | $SUDO tee "$dropin" >/dev/null
  $SUDO systemctl daemon-reload
fi

info "Restarting $service (running chats get a few minutes to finish first, new prompts wait in their queue)..."
$SUDO systemctl restart "$service"
for _ in $(seq 1 60); do
  if ss -Hltn "sport = :$port" | grep -q .; then printf '\033[32m%s\033[0m\n' "Dalang is up on port $port."; exit 0; fi
  systemctl is-failed --quiet "$service" && break
  sleep 1
done
printf '\033[31m%s\033[0m\n' "Dalang did not come up on port $port. Last log lines:" >&2
$SUDO journalctl -u "$service" -n 30 --no-pager >&2
exit 1
