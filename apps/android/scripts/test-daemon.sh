#!/usr/bin/env bash
# Isolated Optio Local daemon attached to a private test API (test-api.sh), for terminal and
# transcript work in the Android app. It never touches the user's real daemon or config: its CLI
# config lives in apps/android/e2e/.run/<port>/daemon/xdg (XDG_CONFIG_HOME) and it only exposes
# the playground dirs under apps/android/e2e/.run/<port>/playground/ (e2e-repo: a git checkout
# whose origin is the seeded repo; scratch: a plain dir).
#
#   test-daemon.sh start  [--port N | --auth]           build the CLI if stale, pair, `optio local up`
#   test-daemon.sh stop   [--port N | --auth]
#   test-daemon.sh status [--port N | --auth]
#   test-daemon.sh verify [--port N | --auth] [--agent] shell-terminal round trip over the stream
#                                              WebSocket; --agent also runs ONE headless Claude
#                                              Code session (a real LLM call, ~$0.01, haiku) and
#                                              checks its transcript; that terminal is kept
#
# Against an auth-enabled test API (test-api.sh start --auth; --auth here just picks its default
# port 4980) the daemon pairs as the seeded admin, with the admin's PAT from that API's seed.json.
# One daemon per API port (they would share a host row). The daemon cannot hand this machine's
# Claude login to the test API (see apps/android/e2e/no-host-claude-login.mjs); set
# OPTIO_DEVLAB_SHARE_CLAUDE_LOGIN=1 only to test "refresh token from machine" on purpose.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
E2E_DIR="$REPO_ROOT/apps/android/e2e"
CLI="$REPO_ROOT/apps/cli/dist/optio.js"
REGISTRY="${OPTIO_DEVLAB_STATE:-$HOME/.android/optio-devlab}/test-daemon"
API_REGISTRY="${OPTIO_DEVLAB_STATE:-$HOME/.android/optio-devlab}/test-api"
DEFAULT_REPO_URL="https://github.com/e2e-org/e2e-repo"

log() { echo "test-daemon.sh: $*" >&2; }
die() {
  echo "test-daemon.sh: error: $*" >&2
  exit 1
}
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }

now() { date +%s; }
pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
read_file() { [ -f "$1" ] && cat "$1" || true; }
healthy() { curl -sf -m 3 "http://127.0.0.1:$1/api/health" 2>/dev/null | grep -q '"healthy":true'; }

parse_port() { # sets PORT, AGENT and the paths; loads the API's auth (TOKEN, WORKSPACE_ID)
  PORT=""
  AGENT=0
  local auth=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) PORT="${2:-}"; shift 2 ;;
      --port=*) PORT="${1#*=}"; shift ;;
      --auth) auth=1; shift ;;
      --agent) AGENT=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option '$1'" ;;
    esac
  done
  [ -n "$PORT" ] || PORT=$([ "$auth" = 1 ] && echo 4980 || echo 4961)
  case "$PORT" in
    '' | *[!0-9]*) die "port must be a number, got '$PORT'" ;;
    30400 | 30310) die "port $PORT is the user's real Optio server; never attach the test daemon there" ;;
  esac
  RUN_DIR="$E2E_DIR/.run/$PORT"
  DAEMON_DIR="$RUN_DIR/daemon"
  XDG_DIR="$DAEMON_DIR/xdg"
  PLAYGROUND="$RUN_DIR/playground"
  SERVER="http://127.0.0.1:$PORT"
  # The API may have been started from another worktree: its run dir has seed.json (read only).
  API_RUN_DIR="$RUN_DIR"
  [ -L "$API_REGISTRY/$PORT" ] && API_RUN_DIR="$(readlink "$API_REGISTRY/$PORT")"
  SEED_JSON="$API_RUN_DIR/seed.json"
  TOKEN=""
  WORKSPACE_ID=""
  AUTH_CURL=()
  if [ "$(seed_get api.authDisabled)" = "false" ]; then
    TOKEN="$(seed_get auth.adminToken)"
    WORKSPACE_ID="$(seed_get auth.workspaceId)"
    [ -n "$TOKEN" ] || die "the test API on port $PORT has auth enabled but $SEED_JSON has no auth.adminToken"
    AUTH_CURL=(-H "authorization: Bearer $TOKEN")
  fi
}

seed_get() { # <dotted.path> from the API's seed.json ("" when absent)
  [ -f "$SEED_JSON" ] || return 0
  node -e 'try { let v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); for (const k of process.argv[2].split(".")) v = v == null ? v : v[k]; if (v !== undefined && v !== null) console.log(v) } catch {}' "$SEED_JSON" "$1"
}

# The daemon's own pid, only if it is still OUR `local up` for this port (never anything else).
our_daemon_pid() { # <daemon dir> <port>
  local pid cmd
  pid="$(read_file "$1/daemon.pid")"
  pid_alive "$pid" || return 0
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  case "$cmd" in
    *optio.js*"--server http://127.0.0.1:$2 "*"local up"*) echo "$pid" ;;
  esac
}

# The daemon registered for <port> by any worktree (dir of a live one), preferring ours.
live_daemon_dir() {
  if [ -n "$(our_daemon_pid "$DAEMON_DIR" "$PORT")" ]; then
    echo "$DAEMON_DIR"
    return
  fi
  local link="$REGISTRY/$PORT" dir
  [ -L "$link" ] || return 0
  dir="$(readlink "$link")"
  [ -n "$(our_daemon_pid "$dir" "$PORT")" ] && echo "$dir" || rm -f "$link"
}

cli() { # run the CLI against the test API with the private config
  env -u OPTIO_TOKEN -u OPTIO_SERVER -u CLAUDE_EFFORT XDG_CONFIG_HOME="$XDG_DIR" \
    node "$CLI" --server "$SERVER" --api-key devlab "$@"
}

host_id() { # the host id the daemon registered, from its private local.json
  local f="$XDG_DIR/optio/local.json"
  [ -f "$f" ] || return 0
  node -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const id = (c.hostIds || {})[process.argv[2]]; if (id) console.log(id) } catch {}' "$f" "$SERVER"
}

host_field() { # <host id> <field>  from GET /api/local/hosts
  curl -sf -m 5 ${AUTH_CURL[@]+"${AUTH_CURL[@]}"} "$SERVER/api/local/hosts" 2>/dev/null |
    node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { const h = JSON.parse(s).hosts.find((x) => x.id === process.argv[1]); if (h) console.log(typeof h[process.argv[2]] === "object" ? JSON.stringify(h[process.argv[2]]) : h[process.argv[2]]) } catch {} })' "$1" "$2"
}

build_cli_if_stale() {
  local stale=""
  if [ ! -f "$CLI" ]; then
    stale="missing"
  elif [ -n "$(find "$REPO_ROOT/apps/cli/src" "$REPO_ROOT/packages/shared/src" -type f -newer "$CLI" 2>/dev/null | head -1)" ]; then
    stale="older than its sources"
  fi
  if [ -n "$stale" ]; then
    [ -d "$REPO_ROOT/apps/cli/node_modules" ] ||
      die "run 'pnpm install --frozen-lockfile --prefer-offline' in $REPO_ROOT first"
    log "building the CLI ($stale)"
    (cd "$REPO_ROOT" && pnpm --filter @optio/cli build >/dev/null) || die "CLI build failed (pnpm --filter @optio/cli build)"
  fi
}

seeded_repo_url() {
  local url
  url="$(seed_get repos.main.repoUrl)"
  echo "${url:-$DEFAULT_REPO_URL}"
}

make_playground() {
  local g=(git -c user.name="Optio DevLab" -c user.email="devlab@example.invalid" -c init.defaultBranch=main)
  if [ ! -d "$PLAYGROUND/e2e-repo/.git" ]; then
    mkdir -p "$PLAYGROUND/e2e-repo"
    printf '# e2e-repo playground\n\nA throwaway checkout for the Optio Android dev lab daemon.\n' >"$PLAYGROUND/e2e-repo/README.md"
    "${g[@]}" -C "$PLAYGROUND/e2e-repo" init -q
    "${g[@]}" -C "$PLAYGROUND/e2e-repo" add README.md
    "${g[@]}" -C "$PLAYGROUND/e2e-repo" commit -qm "Initial commit"
  fi
  # Same spelling as the seeded repo, so Local runs match the checkout to it.
  "${g[@]}" -C "$PLAYGROUND/e2e-repo" remote remove origin 2>/dev/null || true
  "${g[@]}" -C "$PLAYGROUND/e2e-repo" remote add origin "$(seeded_repo_url)"
  if [ ! -d "$PLAYGROUND/scratch/.git" ]; then
    # Its own (remote-less) repo, so remote detection doesn't climb into the worktree's repo.
    mkdir -p "$PLAYGROUND/scratch"
    printf 'scratch space for DevLab terminals\n' >"$PLAYGROUND/scratch/NOTES.txt"
    "${g[@]}" -C "$PLAYGROUND/scratch" init -q
  fi
}

cmd_start() {
  parse_port "$@"
  healthy "$PORT" || die "no healthy test API on port $PORT; start it first: apps/android/scripts/test-api.sh start --port $PORT"
  local other
  other="$(live_daemon_dir)"
  if [ -n "$other" ]; then
    if [ "$other" = "$DAEMON_DIR" ]; then
      log "already running (pid $(our_daemon_pid "$DAEMON_DIR" "$PORT"))"
      print_status
      return 0
    fi
    die "a test daemon for port $PORT is already running from $other; use it (one daemon per API)"
  fi
  command -v node >/dev/null || die "node not found"
  build_cli_if_stale

  mkdir -p "$DAEMON_DIR" "$XDG_DIR"
  make_playground
  cli local add "$PLAYGROUND/e2e-repo" >/dev/null
  cli local add "$PLAYGROUND/scratch" >/dev/null

  local preload=() creds=(--api-key devlab)
  [ "${OPTIO_DEVLAB_SHARE_CLAUDE_LOGIN:-}" = "1" ] || preload=(--import "$E2E_DIR/no-host-claude-login.mjs")
  # Auth-enabled API: pair as the seeded admin (their PAT; the workspace pins the REST calls),
  # and hold the first frames a moment (see apps/android/e2e/ws-open-grace.mjs: the API drops a
  # hello sent the instant the socket opens when it has a PAT to look up).
  if [ -n "$TOKEN" ]; then
    creds=(--api-key "$TOKEN" --workspace "$WORKSPACE_ID")
    preload+=(--import "$E2E_DIR/ws-open-grace.mjs")
  fi
  [ -f "$DAEMON_DIR/daemon.log" ] && mv -f "$DAEMON_DIR/daemon.log" "$DAEMON_DIR/daemon.log.1"
  # New session so the daemon outlives this shell; env -u drops the caller's Optio credentials
  # and this Claude session's effort override (it would leak into agents the daemon spawns).
  nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec failed: $!\n"' \
    env -u OPTIO_TOKEN -u OPTIO_SERVER -u CLAUDE_EFFORT XDG_CONFIG_HOME="$XDG_DIR" \
    node ${preload[@]+"${preload[@]}"} "$CLI" --server "$SERVER" "${creds[@]}" local up \
    >"$DAEMON_DIR/daemon.log" 2>&1 </dev/null &
  local pid=$!
  echo "$pid" >"$DAEMON_DIR/daemon.pid"
  mkdir -p "$REGISTRY"
  ln -sfn "$DAEMON_DIR" "$REGISTRY/$PORT"
  log "starting (pid $pid, log $DAEMON_DIR/daemon.log)"

  local deadline=$(($(now) + 60)) id="" state=""
  while [ "$(now)" -lt "$deadline" ]; do
    pid_alive "$pid" || {
      echo "test-daemon.sh: error: the daemon exited. Log:" >&2
      tail -n 30 "$DAEMON_DIR/daemon.log" >&2
      rm -f "$DAEMON_DIR/daemon.pid" "$REGISTRY/$PORT"
      exit 1
    }
    id="$(host_id)"
    [ -n "$id" ] && state="$(host_field "$id" state)"
    [ "$state" = "online" ] && break
    sleep 1
  done
  if [ "$state" != "online" ]; then
    echo "test-daemon.sh: error: the host never came online (host id '${id:-?}'). Log:" >&2
    tail -n 30 "$DAEMON_DIR/daemon.log" >&2
    stop_daemon
    exit 1
  fi
  echo "$id" >"$DAEMON_DIR/host.id"
  log "host online"
  print_status
}

stop_daemon() {
  local pid
  pid="$(our_daemon_pid "$DAEMON_DIR" "$PORT")"
  if [ -n "$pid" ]; then
    # SIGTERM: the daemon kills its terminals, closes the socket and exits within ~200ms.
    kill -TERM "$pid" 2>/dev/null || true
    local deadline=$(($(now) + 10))
    while pid_alive "$pid" && [ "$(now)" -lt "$deadline" ]; do sleep 0.3; done
    pid_alive "$pid" && kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$DAEMON_DIR/daemon.pid"
  [ "$(readlink "$REGISTRY/$PORT" 2>/dev/null || true)" = "$DAEMON_DIR" ] && rm -f "$REGISTRY/$PORT"
  return 0
}

cmd_stop() {
  parse_port "$@"
  local other
  other="$(live_daemon_dir)"
  if [ -n "$other" ] && [ "$other" != "$DAEMON_DIR" ]; then
    die "the test daemon for port $PORT was started from another worktree ($other); only its owner should stop it"
  fi
  if [ -z "$(our_daemon_pid "$DAEMON_DIR" "$PORT")" ]; then
    rm -f "$DAEMON_DIR/daemon.pid"
    log "no test daemon running for port $PORT"
    return 0
  fi
  log "stopping (pid $(our_daemon_pid "$DAEMON_DIR" "$PORT"))"
  stop_daemon
  log "stopped"
}

print_status() {
  local id pid
  pid="$(our_daemon_pid "$DAEMON_DIR" "$PORT")"
  id="$(host_id)"
  echo "Optio Local test daemon for $SERVER"
  echo "  pid:        ${pid:-not running}"
  if [ -n "$TOKEN" ]; then
    echo "  auth:       paired as $(seed_get auth.users.admin.displayName) with the admin PAT from $SEED_JSON"
  else
    echo "  auth:       disabled on this API"
  fi
  echo "  host id:    ${id:-?}"
  if [ -n "$id" ] && healthy "$PORT"; then
    echo "  host:       $(host_field "$id" name) ($(host_field "$id" state), claudeCredentials=$(host_field "$id" claudeCredentials))"
  fi
  echo "  dirs:       $PLAYGROUND/e2e-repo ($(seeded_repo_url))"
  echo "              $PLAYGROUND/scratch"
  echo "  config:     XDG_CONFIG_HOME=$XDG_DIR"
  echo "  log:        $DAEMON_DIR/daemon.log"
}

cmd_status() {
  parse_port "$@"
  local other
  other="$(live_daemon_dir)"
  if [ -n "$other" ] && [ "$other" != "$DAEMON_DIR" ]; then
    echo "a test daemon for port $PORT is running from another worktree: $other"
    return 0
  fi
  if [ -z "$(our_daemon_pid "$DAEMON_DIR" "$PORT")" ]; then
    echo "no test daemon running for port $PORT"
    exit 3
  fi
  print_status
}

cmd_verify() {
  parse_port "$@"
  healthy "$PORT" || die "no healthy test API on port $PORT"
  local live
  live="$(live_daemon_dir)"
  [ -n "$live" ] || die "no test daemon running for port $PORT; run: test-daemon.sh start --port $PORT"
  # The daemon may have been started from another worktree: use its config and playground.
  DAEMON_DIR="$live"
  RUN_DIR="$(dirname "$live")"
  XDG_DIR="$live/xdg"
  PLAYGROUND="$RUN_DIR/playground"
  local args=(--port "$PORT" --host-id "$(host_id)" --scratch "$PLAYGROUND/scratch" --repo-dir "$PLAYGROUND/e2e-repo")
  [ -n "$TOKEN" ] && args+=(--token "$TOKEN")
  # Results go into the API's seed.json only when that run dir is this worktree's own.
  case "$API_RUN_DIR" in "$E2E_DIR"/*) args+=(--run-dir "$API_RUN_DIR") ;; esac
  [ "$AGENT" = 1 ] && args+=(--agent)
  node "$E2E_DIR/verify-daemon.mjs" "${args[@]}"
}

main() {
  local cmd="${1:-help}"
  [ $# -gt 0 ] && shift
  case "$cmd" in
    start) cmd_start "$@" ;;
    stop) cmd_stop "$@" ;;
    status) cmd_status "$@" ;;
    verify) cmd_verify "$@" ;;
    help | -h | --help) usage ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
