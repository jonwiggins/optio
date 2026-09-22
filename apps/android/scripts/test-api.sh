#!/usr/bin/env bash
# Private Optio API for Android dev and tests: the REAL API server with the fake container
# runtime, auth disabled, a private Postgres database and Redis DB, and seeded data.
#
#   test-api.sh start  [--port N] [--no-seed] [--timeout SECS] [--log-level LEVEL]
#   test-api.sh stop   [--port N] [--force]
#   test-api.sh status [--port N | --all]
#
# Port 4961 is the shared instance; use 4962-4979 for a private one. The host reaches it at
# http://127.0.0.1:<port>, an emulator at http://10.0.2.2:<port> (it listens on loopback only).
# State lives in apps/android/e2e/.run/<port>/: api.log, launcher.pid, api.pid, server.json and
# seed.json (the seeded ids). `start` returns once the API is healthy AND seeding finished.
# An instance started from another worktree is reported by `status`/`start` (found through
# ~/.android/optio-devlab/test-api/<port>) but only stopped with --force.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
E2E_DIR="$REPO_ROOT/apps/android/e2e"
TSX="$REPO_ROOT/apps/api/node_modules/.bin/tsx"
REGISTRY="${OPTIO_DEVLAB_STATE:-$HOME/.android/optio-devlab}/test-api"

log() { echo "test-api.sh: $*" >&2; }
die() {
  echo "test-api.sh: error: $*" >&2
  exit 1
}
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }

now() { date +%s; }
pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
read_file() { [ -f "$1" ] && cat "$1" || true; }

healthy() { curl -sf -m 3 "http://127.0.0.1:$1/api/health" 2>/dev/null | grep -q '"healthy":true'; }
listening_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }

# Field from a flat JSON file: json_field <file> <key> (strings, numbers, booleans).
json_field() {
  [ -f "$1" ] || return 0
  node -e 'try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (v !== undefined && v !== null) console.log(v) } catch {}' "$1" "$2"
}

validate_port() {
  case "$1" in
    '' | *[!0-9]*) die "port must be a number, got '$1'" ;;
  esac
  case "$1" in
    4931 | 3131) die "port $1 belongs to the web e2e stack; use 4961 (shared) or 4962-4979 (private)" ;;
    30400 | 30310) die "port $1 is the user's real Optio server; never point the test API there" ;;
  esac
  [ "$1" -ge 1024 ] && [ "$1" -le 65535 ] || die "port out of range: $1"
}

# Where an instance's state lives: this worktree's run dir, unless the registry says another
# worktree owns a live launcher for the port.
local_run_dir() { echo "$E2E_DIR/.run/$1"; }
registered_run_dir() {
  local link="$REGISTRY/$1"
  [ -L "$link" ] && readlink "$link" || true
}
launcher_pid_of() { read_file "$1/launcher.pid"; }

owner_run_dir() { # prints the run dir of a live instance on <port>, preferring ours
  local port="$1" dir
  dir="$(local_run_dir "$port")"
  if pid_alive "$(launcher_pid_of "$dir")"; then
    echo "$dir"
    return
  fi
  dir="$(registered_run_dir "$port")"
  if [ -n "$dir" ] && pid_alive "$(launcher_pid_of "$dir")"; then echo "$dir"; fi
}

print_summary() {
  local port="$1" dir="$2"
  echo "Optio test API on port $port"
  echo "  host URL:      http://127.0.0.1:$port"
  echo "  emulator URL:  http://10.0.2.2:$port"
  echo "  health:        $(healthy "$port" && echo healthy || echo 'NOT healthy')"
  echo "  phase:         $(json_field "$dir/server.json" phase)"
  echo "  launcher pid:  $(launcher_pid_of "$dir")   api pid: $(read_file "$dir/api.pid")"
  echo "  database:      $(json_field "$dir/server.json" dbName)"
  echo "  seed manifest: $dir/seed.json$([ -f "$dir/seed.json" ] || echo ' (not written)')"
  echo "  log:           $dir/api.log"
  local owner
  owner="$(json_field "$dir/server.json" repoRoot)"
  [ -z "$owner" ] || [ "$owner" = "$REPO_ROOT" ] || echo "  started from:  $owner (another worktree)"
}

kill_group_or_pid() { # <pid> <signal>
  kill "-$2" -- "-$1" 2>/dev/null || kill "-$2" "$1" 2>/dev/null || true
}

cmd_start() {
  local port=4961 seed=1 timeout=420 level="warn"
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) port="${2:-}"; shift 2 ;;
      --port=*) port="${1#*=}"; shift ;;
      --no-seed) seed=0; shift ;;
      --timeout) timeout="${2:-}"; shift 2 ;;
      --log-level) level="${2:-}"; shift 2 ;;
      -h | --help) usage; exit 0 ;;
      *) die "start: unknown option '$1'" ;;
    esac
  done
  validate_port "$port"

  local existing
  existing="$(owner_run_dir "$port")"
  if [ -n "$existing" ]; then
    if [ "$(json_field "$existing/server.json" phase)" = "ready" ] && healthy "$port"; then
      log "already running (launcher pid $(launcher_pid_of "$existing"))"
      print_summary "$port" "$existing"
      return 0
    fi
    die "an instance on port $port is still starting or unhealthy (run dir $existing); check its log or stop it"
  fi
  local holder
  holder="$(listening_pid "$port")"
  [ -z "$holder" ] || die "port $port is already in use by pid $holder ($(ps -o command= -p "$holder" | cut -c1-120)); pick another port"

  [ -x "$TSX" ] || die "missing $TSX; run 'pnpm install --frozen-lockfile --prefer-offline' in $REPO_ROOT"
  docker info >/dev/null 2>&1 || die "Docker is not running (the test Postgres/Redis containers need it)"

  local dir
  dir="$(local_run_dir "$port")"
  mkdir -p "$dir"
  rm -f "$dir/server.json" "$dir/seed.json" "$dir/launcher.pid" "$dir/api.pid"
  [ -f "$dir/api.log" ] && mv -f "$dir/api.log" "$dir/api.log.1"

  local args=("$E2E_DIR/launch-api.ts" --port "$port" --run-dir "$dir" --log-level "$level")
  [ "$seed" = 1 ] || args+=(--no-seed)
  # New session so the launcher (and the API it spawns) outlive this shell. `exec` keeps one pid
  # from the subshell through nohup and perl to tsx, so $! is the launcher itself.
  (cd "$REPO_ROOT/apps/api" && exec nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec failed: $!\n"' \
    "$TSX" "${args[@]}") >>"$dir/api.log" 2>&1 </dev/null &
  local lpid=$!
  echo "$lpid" >"$dir/launcher.pid"
  mkdir -p "$REGISTRY"
  ln -sfn "$dir" "$REGISTRY/$port"
  log "starting on port $port (launcher pid $lpid, log $dir/api.log)"

  local started phase
  started="$(now)"
  while :; do
    phase="$(json_field "$dir/server.json" phase)"
    [ "$phase" = "ready" ] && break
    if [ "$phase" = "failed" ] || ! pid_alive "$lpid"; then
      echo "test-api.sh: error: the test API failed to start ($(json_field "$dir/server.json" error)). Last log lines:" >&2
      tail -n 40 "$dir/api.log" >&2 || true
      stop_dir "$port" "$dir" >/dev/null 2>&1 || true
      exit 1
    fi
    if [ $(($(now) - started)) -ge "$timeout" ]; then
      echo "test-api.sh: error: not ready after ${timeout}s (phase '${phase:-starting}'). Last log lines:" >&2
      tail -n 40 "$dir/api.log" >&2 || true
      stop_dir "$port" "$dir" >/dev/null 2>&1 || true
      exit 1
    fi
    sleep 1
  done
  log "ready in $(($(now) - started))s"
  print_summary "$port" "$dir"
}

stop_dir() { # <port> <run dir>
  local port="$1" dir="$2" lpid apid
  lpid="$(launcher_pid_of "$dir")"
  apid="$(read_file "$dir/api.pid")"
  if pid_alive "$lpid"; then
    # The launcher stops the API server and drops the private database on SIGTERM.
    kill -TERM "$lpid" 2>/dev/null || true
    local deadline=$(($(now) + 30))
    while pid_alive "$lpid" && [ "$(now)" -lt "$deadline" ]; do sleep 0.5; done
    if pid_alive "$lpid"; then
      log "launcher $lpid did not exit, killing it"
      kill_group_or_pid "$lpid" KILL
    fi
  fi
  if pid_alive "$apid"; then
    kill_group_or_pid "$apid" TERM
    local deadline=$(($(now) + 10))
    while pid_alive "$apid" && [ "$(now)" -lt "$deadline" ]; do sleep 0.5; done
    pid_alive "$apid" && kill_group_or_pid "$apid" KILL
  fi
  rm -f "$dir/launcher.pid" "$dir/api.pid" "$dir/server.json" "$dir/seed.json"
  [ "$(registered_run_dir "$port")" = "$dir" ] && rm -f "$REGISTRY/$port"
  return 0
}

cmd_stop() {
  local port=4961 force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) port="${2:-}"; shift 2 ;;
      --port=*) port="${1#*=}"; shift ;;
      --force) force=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "stop: unknown option '$1'" ;;
    esac
  done
  validate_port "$port"
  local dir
  dir="$(owner_run_dir "$port")"
  if [ -z "$dir" ]; then
    # Nothing live; tidy a stale local run dir (e.g. the launcher was killed by hand).
    local local_dir
    local_dir="$(local_run_dir "$port")"
    [ -d "$local_dir" ] && stop_dir "$port" "$local_dir"
    if healthy "$port"; then
      die "port $port serves an API this script did not start (pid $(listening_pid "$port")); not touching it"
    fi
    log "no test API running on port $port"
    return 0
  fi
  if [ "$dir" != "$(local_run_dir "$port")" ] && [ "$force" != 1 ]; then
    die "the test API on port $port was started from another worktree ($dir); only its owner should stop it (or pass --force)"
  fi
  log "stopping port $port (launcher pid $(launcher_pid_of "$dir"))"
  stop_dir "$port" "$dir"
  log "stopped"
}

cmd_status() {
  local port=4961 all=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) port="${2:-}"; shift 2 ;;
      --port=*) port="${1#*=}"; shift ;;
      --all) all=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "status: unknown option '$1'" ;;
    esac
  done
  if [ "$all" = 1 ]; then
    local any=0 link
    for link in "$REGISTRY"/*; do
      [ -L "$link" ] || continue
      local p d
      p="$(basename "$link")"
      d="$(readlink "$link")"
      if pid_alive "$(launcher_pid_of "$d")"; then
        any=1
        print_summary "$p" "$d"
        echo
      else
        rm -f "$link"
      fi
    done
    [ "$any" = 1 ] || echo "no test API instances running"
    return 0
  fi
  validate_port "$port"
  local dir
  dir="$(owner_run_dir "$port")"
  if [ -z "$dir" ]; then
    if healthy "$port"; then
      echo "port $port serves a healthy API that test-api.sh did not start (pid $(listening_pid "$port"))"
    else
      echo "no test API running on port $port"
    fi
    exit 3
  fi
  print_summary "$port" "$dir"
  [ "$(json_field "$dir/server.json" phase)" = "ready" ] && healthy "$port"
}

main() {
  local cmd="${1:-help}"
  [ $# -gt 0 ] && shift
  case "$cmd" in
    start) cmd_start "$@" ;;
    stop) cmd_stop "$@" ;;
    status) cmd_status "$@" ;;
    help | -h | --help) usage ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
