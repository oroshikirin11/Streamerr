#!/usr/bin/env bash
# Update Streamerr to the latest code, keeping everything you made.
#
#   ./update.sh            pull, rebuild, restart
#   ./update.sh --dry-run  show what would happen, change nothing
#   ./update.sh --yes      do not stop for a running broadcast
#   ./update.sh --mode docker|standalone   when the guess is wrong
#
# What survives an update, always: config.json and schedules.json (or the
# directory STREAMERR_CONFIG points at), uploaded Studio pictures
# (overlays/), the cache, and the run directory. They are ignored by git and
# mounted as volumes under Docker, so neither a pull nor a rebuild touches
# them. This script never runs `git clean` or `git reset`; local changes to
# tracked files stop it instead of being thrown away — except
# docker-compose.yml, which every install edits (the media volume, the
# render group, the ports): that one is set aside for the pull and put back.
set -euo pipefail

cd "$(dirname "$0")"

DRY=0
YES=0
FORCE_MODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    --mode) shift; FORCE_MODE="${1:-}"; [ "$FORCE_MODE" = docker ] || [ "$FORCE_MODE" = standalone ] || { echo "--mode takes docker or standalone" >&2; exit 2; } ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then note "would run: $*"; else "$@"; fi; }

# ── what we keep ─────────────────────────────────────────────────────────
bold "Streamerr update"
CONFIG_FILE="${STREAMERR_CONFIG:-${JELLYSTREAMERR_CONFIG:-$PWD/config.json}}"
CONFIG_DIR="$(dirname "$CONFIG_FILE")"
note "config: $CONFIG_FILE"
for p in "$CONFIG_DIR/schedules.json" overlays cache run; do
  [ -e "$p" ] && note "keeping $p"
done

# ── preflight ────────────────────────────────────────────────────────────
command -v git >/dev/null || die "git is not installed."
[ -d .git ] || die "This is not a git checkout, so there is nothing to pull. Re-download the project instead."
git remote get-url origin >/dev/null 2>&1 || die "No 'origin' remote — add one: git remote add origin https://github.com/oroshikirin11/Streamerr"

# docker-compose.yml is yours to edit — the media volume, the render group,
# the ports — so a changed one never blocks an update: it is set aside for
# the pull and put back after. Any OTHER tracked file changed locally is
# still a stop, since the pull would have to merge it.
OTHER_CHANGES="$(git status --short --untracked-files=no | grep -v ' docker-compose.yml$' || true)"
if [ -n "$OTHER_CHANGES" ]; then
  printf '%s\n' "$OTHER_CHANGES" | sed 's/^/  /'
  die "Tracked files besides docker-compose.yml were changed locally (listed above). Keep them with 'git stash', or drop them with 'git checkout -- .', then run this again."
fi
COMPOSE_EDITED=0
if ! git diff --quiet -- docker-compose.yml || ! git diff --cached --quiet -- docker-compose.yml; then
  COMPOSE_EDITED=1
  note "keeping your edited docker-compose.yml"
fi

MODE=standalone
if [ -f docker-compose.yml ] && command -v docker >/dev/null 2>&1; then
  if docker compose ps --services --status running 2>/dev/null | grep -q . \
     || { [ ! -d node_modules ] && docker compose config >/dev/null 2>&1; }; then
    MODE=docker
  fi
fi
[ -n "$FORCE_MODE" ] && MODE="$FORCE_MODE"
note "mode: $MODE$([ -n "$FORCE_MODE" ] && echo ' (given)' || echo ' (guessed — override with --mode)')"

# A running broadcast stops when the service restarts; say so before doing it.
PORT="${STREAMERR_PORT:-8099}"
STATUS="$(curl -s -m 3 "http://127.0.0.1:$PORT/api/stream/status" 2>/dev/null | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p' || true)"
if [ -n "$STATUS" ] && [ "$STATUS" != "stopped" ]; then
  if [ "$YES" = 1 ]; then
    note "a broadcast is on air ($STATUS) — continuing because of --yes; it will end at the restart"
  else
    die "A broadcast is on air ($STATUS). Updating restarts the service and ends it. Stop it first, or run with --yes."
  fi
fi

# ── what is new ──────────────────────────────────────────────────────────
git fetch --quiet origin
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo "origin/$BRANCH")"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "$UPSTREAM" 2>/dev/null || die "Cannot see $UPSTREAM — is the branch pushed?")"
if [ "$LOCAL" = "$REMOTE" ]; then
  bold "Already up to date: $(git log -1 --format='%h · %cs · %s')"
  exit 0
fi
if ! git merge-base --is-ancestor "$LOCAL" "$REMOTE"; then
  die "This checkout has commits that are not on $UPSTREAM. Update by hand: git pull --rebase, then build."
fi
COUNT="$(git rev-list --count "$LOCAL..$REMOTE")"
bold "$COUNT new commit$([ "$COUNT" = 1 ] || echo s) on $UPSTREAM:"
git log --format='  %h · %cs · %s' "$LOCAL..$REMOTE" | head -30
[ "$COUNT" -gt 30 ] && note "… and $((COUNT - 30)) more"

# ── a small backup of the things that matter ─────────────────────────────
# Config and schedules are tiny; pictures too. The cache is not backed up —
# it is rebuilt on demand and can be gigabytes.
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p backups
BACKUP="backups/streamerr-$STAMP.tar.gz"
KEEP=()
for p in "$CONFIG_FILE" "$CONFIG_DIR/schedules.json" overlays; do [ -e "$p" ] && KEEP+=("$p"); done
if [ "${#KEEP[@]}" -gt 0 ]; then
  run tar -czf "$BACKUP" "${KEEP[@]}" 2>/dev/null || true
  note "backup: $BACKUP"
  # keep the five newest
  (ls -1t backups/streamerr-*.tar.gz 2>/dev/null || true) | tail -n +6 | while read -r old; do run rm -f "$old"; done
fi

# ── pull ─────────────────────────────────────────────────────────────────
if [ "$COMPOSE_EDITED" = 1 ]; then
  run git stash push --quiet -m "streamerr-update: docker-compose.yml" -- docker-compose.yml
fi
run git pull --ff-only --quiet origin "$BRANCH"
if [ "$COMPOSE_EDITED" = 1 ] && [ "$DRY" = 0 ]; then
  # Your file comes back as it was. If upstream changed the same file, its
  # new port lines are listed so you can add what matters — the secure
  # address on 8443, say — and the rest of its diff is one command away.
  UPSTREAM_COMPOSE="$(git show HEAD:docker-compose.yml)"
  git checkout --quiet stash@{0} -- docker-compose.yml
  git stash drop --quiet
  git reset --quiet -- docker-compose.yml
  # Compared by the CONTAINER side of each mapping: a host port you remapped
  # is still the same service, not a missing one.
  MINE="$(grep -oE '"[0-9]+:[0-9]+(/[a-z]+)?"' docker-compose.yml | sed -E 's/"[0-9]+:([0-9]+(\/[a-z]+)?)"/\1/' || true)"
  NEW_LINES="$(printf '%s\n' "$UPSTREAM_COMPOSE" | grep -E '^\s*-\s*"[0-9]+:[0-9]+' | while IFS= read -r line; do
    cport="$(printf '%s' "$line" | grep -oE '"[0-9]+:[0-9]+(/[a-z]+)?"' | sed -E 's/"[0-9]+:([0-9]+(\/[a-z]+)?)"/\1/')"
    printf '%s\n' "$MINE" | grep -qxF "$cport" || printf '%s\n' "$line"
  done)"
  if [ -n "$NEW_LINES" ]; then
    bold "Upstream docker-compose.yml has port lines yours does not:"
    printf '%s\n' "$NEW_LINES" | sed 's/^/  /'
    note "add the ones you need to your docker-compose.yml (8443 is the secure address for screen sharing), then: docker compose up -d"
  fi
  note "everything upstream changed in docker-compose.yml: git diff HEAD -- docker-compose.yml"
fi

# ── rebuild and restart ──────────────────────────────────────────────────
wait_up() {
  local i
  for i in $(seq 1 60); do
    if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/auth/status"; then return 0; fi
    sleep 1
  done
  return 1
}

if [ "$MODE" = docker ]; then
  bold "Rebuilding the container (config, cache and pictures are volumes and stay put)"
  run docker compose up -d --build
  # Every --build leaves build cache behind that docker never collects on
  # its own; keep the last day's so rebuilds stay fast, drop the rest.
  run docker builder prune -f --filter until=24h
  if [ "$DRY" = 0 ]; then
    if wait_up; then note "panel is up on port $PORT"; else note "the panel did not answer within 60 s — check: docker compose logs --tail 50"; fi
  fi
else
  command -v node >/dev/null || die "node is not installed."
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR is too old; Streamerr needs 20 or newer."
  bold "Installing dependencies and building the panel"
  if [ -f package-lock.json ]; then run npm ci --omit=dev --no-audit --no-fund; else run npm install --omit=dev --no-audit --no-fund; fi
  ( cd web && if [ -f package-lock.json ]; then run npm ci --no-audit --no-fund; else run npm install --no-audit --no-fund; fi && run npm run build )
  bold "Restarting"
  if systemctl list-units --type=service --all 2>/dev/null | grep -q 'streamerr\.service'; then
    run sudo systemctl restart streamerr
    [ "$DRY" = 0 ] && { wait_up && note "panel is up on port $PORT" || note "the panel did not answer within 60 s — check: journalctl -u streamerr -n 50"; }
  elif systemctl --user list-units --type=service --all 2>/dev/null | grep -q 'streamerr\.service'; then
    run systemctl --user restart streamerr
  elif pgrep -f 'src/index.js' >/dev/null; then
    note "Streamerr is running outside a service manager — restart it yourself: stop the old 'node src/index.js' and start it again."
  else
    note "Streamerr is not running; start it with: node src/index.js"
  fi
fi

bold "Now at $(git log -1 --format='%h · %cs · %s')"
