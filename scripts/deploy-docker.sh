#!/usr/bin/env bash
# Deploys one commit of master to a Docker install (see "Continuous deployment" in docs/setup.md).
# Installed as root on the server (not run from the checkout, so a push cannot change what the deploy key may run):
#   install -m 755 scripts/deploy-docker.sh /usr/local/bin/dalang-deploy
# Usage: dalang-deploy <40-hex commit sha>   (what .github/workflows/deploy.yml sends through the deploy key)
#   Fetches origin, fast-forwards the checkout to that commit (refusing anything not on origin/master), builds the
#   image while the old container keeps serving, then replaces it and waits until it reports healthy. The replacement
#   lets running chats finish first (DRAIN_MINUTES; compose's stop_grace_period must be longer). A failed fetch or build
#   leaves the running container alone.
# Environment: DALANG_DIR (default /opt/lzvr-dalang), DALANG_BRANCH (default master). The checkout's owner runs git.
set -euo pipefail

dir=${DALANG_DIR:-/opt/lzvr-dalang}
branch=${DALANG_BRANCH:-master}
sha=${1:-}

fail() { printf '%s\n' "deploy: $*" >&2; exit 1; }
info() { printf '%s\n' "deploy: $*"; }

[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo dalang-deploy <sha>)'
[[ $sha =~ ^[0-9a-f]{40}$ ]] || fail 'expected a full 40-character commit sha'
cd "$dir"

# One deploy at a time: a second push waits for the first instead of racing it.
exec 9>/run/lock/dalang-deploy.lock
flock -w 3600 9 || fail 'another deploy is still running'

owner=$(stat -c %U .)
as_owner() { runuser -u "$owner" -- "$@"; }

info "fetching origin/$branch"
as_owner git fetch --quiet origin "$branch"
as_owner git cat-file -e "$sha^{commit}" 2>/dev/null || fail "commit $sha not found on origin"
as_owner git merge-base --is-ancestor "$sha" "origin/$branch" || fail "commit $sha is not on origin/$branch"

before=$(as_owner git rev-parse HEAD)
if [ "$before" != "$sha" ]; then
  as_owner git merge-base --is-ancestor "$before" "$sha" || fail "checkout is at $before, which $sha does not contain (local commits?)"
  as_owner git merge --ff-only --quiet "$sha"
fi
info "checkout at $(as_owner git log -1 --format='%h %s')"

info 'building the image (the running container keeps serving)'
docker compose build --pull

info 'replacing the container (running chats get DRAIN_MINUTES to finish)'
docker compose up -d --remove-orphans

container=$(docker compose ps -q dalang)
[ -n "$container" ] || fail 'no dalang container after up'
for _ in $(seq 1 60); do
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")
  case $status in
    healthy) info "healthy at $(as_owner git rev-parse --short HEAD) (was ${before:0:7})"; exit 0 ;;
    unhealthy|exited|dead) break ;;
  esac
  sleep 3
done
docker compose logs --tail 60 dalang >&2 || true
fail "container is $status after the deploy"
