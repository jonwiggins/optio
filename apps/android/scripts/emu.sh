#!/usr/bin/env bash
# Headless Android emulator instances of the shared `optio` AVD, for Optio Android dev and tests.
#
#   emu.sh start [--port N] [--avd NAME] [--window] [--gpu MODE] [--timeout SECS] [--reuse]
#   emu.sh stop <serial|port> [--force] [--timeout SECS]
#   emu.sh list
#   emu.sh http <serial|port> <url>     GET <url> from inside the device (toybox nc) and print it
#
# `start` prints ONLY the serial (emulator-N) on stdout, so `SERIAL=$(emu.sh start --port 5562)`
# works; progress and errors go to stderr. Instances run with -read-only: several can share the
# one AVD, and nothing an instance does survives it (every start is a cold boot from the AVD's
# baked userdata: animations off, stay awake, no lock screen, no adb-install verification).
#
# Instance state (pid, log, owner worktree) lives in ~/.android/optio-devlab/emulators/<port>/ so
# `list` sees every instance on the machine, whichever worktree started it. `stop` refuses to stop
# an instance another worktree started unless you pass --force.
#
# Env: ANDROID_HOME (default ~/Library/Android/sdk), OPTIO_EMU_GPU (default host),
#      OPTIO_EMU_AVD (default optio), OPTIO_DEVLAB_STATE (default ~/.android/optio-devlab).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
EMULATOR="$ANDROID_HOME/emulator/emulator"
ADB="$ANDROID_HOME/platform-tools/adb"
STATE_ROOT="${OPTIO_DEVLAB_STATE:-$HOME/.android/optio-devlab}/emulators"
PORT_MIN=5554
PORT_MAX=5680

log() { echo "emu.sh: $*" >&2; }
die() {
  echo "emu.sh: error: $*" >&2
  exit 1
}

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }

need_tools() {
  [ -x "$EMULATOR" ] || die "emulator not found at $EMULATOR (set ANDROID_HOME)"
  [ -x "$ADB" ] || die "adb not found at $ADB (set ANDROID_HOME)"
  "$ADB" start-server >/dev/null 2>&1 || die "could not start the adb server"
}

now() { date +%s; }

pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# The command line of a pid ("" when gone).
pid_cmd() { ps -o command= -p "$1" 2>/dev/null || true; }

# True when <pid> is an emulator (qemu) process started with -port <port>.
pid_is_emulator_on_port() {
  local cmd
  cmd="$(pid_cmd "$1")"
  case "$cmd" in
    *qemu-system* | *emulator*) ;;
    *) return 1 ;;
  esac
  case " $cmd " in
    *" -port $2 "* | *" -ports $2,"*) return 0 ;;
  esac
  return 1
}

# Pid of a running emulator process for <port>, from any source ("" when none).
find_emulator_pid() {
  local port="$1" pid
  pid="$(state_get "$port" pid)"
  if pid_alive "$pid" && pid_is_emulator_on_port "$pid" "$port"; then
    echo "$pid"
    return
  fi
  # Started some other way (Android Studio, a bare `emulator` call): find it by its arguments.
  ps -ax -o pid=,command= 2>/dev/null |
    awk -v p="$port" '($0 ~ /qemu-system/) && ($0 ~ ("-port " p "( |$)") || $0 ~ ("-ports " p ",")) {print $1; exit}'
}

port_listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }

adb_state() { "$ADB" devices 2>/dev/null | awk -v s="emulator-$1" '$1 == s {print $2}'; }

state_dir() { echo "$STATE_ROOT/$1"; }
state_get() {
  local f
  f="$(state_dir "$1")/$2"
  [ -f "$f" ] && cat "$f" || true
}

# Atomically claim <port> (mkdir is atomic). Reclaims a stale claim whose pid is gone.
claim_port() {
  local port="$1" dir
  dir="$(state_dir "$port")"
  mkdir -p "$STATE_ROOT"
  if mkdir "$dir" 2>/dev/null; then
    echo "$$" >"$dir/claimer"
    return 0
  fi
  local pid claimer
  pid="$(state_get "$port" pid)"
  claimer="$(state_get "$port" claimer)"
  if pid_alive "$pid" && pid_is_emulator_on_port "$pid" "$port"; then return 1; fi
  if [ -z "$pid" ] && pid_alive "$claimer"; then return 1; fi # another start is mid-launch
  rm -rf "$dir"
  mkdir "$dir" 2>/dev/null || return 1
  echo "$$" >"$dir/claimer"
}

release_port() { rm -rf "$(state_dir "$1")"; }

parse_target() { # serial or port -> port
  case "$1" in
    emulator-[0-9]*) echo "${1#emulator-}" ;;
    [0-9]*) echo "$1" ;;
    *) die "expected a serial (emulator-5562) or a console port (5562), got '$1'" ;;
  esac
}

validate_port() {
  case "$1" in
    '' | *[!0-9]*) die "port must be a number, got '$1'" ;;
  esac
  [ "$1" -ge "$PORT_MIN" ] && [ "$1" -le "$PORT_MAX" ] || die "port must be in $PORT_MIN-$PORT_MAX, got $1"
  [ $(($1 % 2)) -eq 0 ] || die "port must be even (console port; adb uses port+1), got $1"
}

describe_port() {
  local port="$1" pid avd owner
  pid="$(find_emulator_pid "$port")"
  avd="$(state_get "$port" avd)"
  owner="$(state_get "$port" owner)"
  echo "serial emulator-$port, adb state '$(adb_state "$port")', pid ${pid:-?}, avd ${avd:-?}, started by ${owner:-something other than emu.sh}"
}

device_prop() { "$ADB" -s "$1" shell getprop "$2" 2>/dev/null | tr -d '\r' || true; }

cmd_start() {
  local port="" avd="${OPTIO_EMU_AVD:-optio}" window=0 gpu="${OPTIO_EMU_GPU:-host}" timeout=240 reuse=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) port="${2:-}"; shift 2 ;;
      --port=*) port="${1#*=}"; shift ;;
      --avd) avd="${2:-}"; shift 2 ;;
      --window) window=1; shift ;;
      --gpu) gpu="${2:-}"; shift 2 ;;
      --timeout) timeout="${2:-}"; shift 2 ;;
      --reuse) reuse=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "start: unknown option '$1'" ;;
    esac
  done
  need_tools
  "$EMULATOR" -list-avds 2>/dev/null | grep -qx "$avd" ||
    die "AVD '$avd' not found (have: $("$EMULATOR" -list-avds 2>/dev/null | tr '\n' ' '))"

  if [ -n "$port" ]; then
    validate_port "$port"
    local running_pid
    running_pid="$(find_emulator_pid "$port")"
    if [ -n "$running_pid" ] || [ -n "$(adb_state "$port")" ] || port_listening "$port"; then
      if [ "$reuse" = 1 ] && [ -n "$running_pid" ] &&
        [ "$(device_prop "emulator-$port" sys.boot_completed)" = "1" ]; then
        log "reusing the emulator already running on port $port ($(describe_port "$port"))"
        echo "emulator-$port"
        return 0
      fi
      die "something is already running on port $port: $(describe_port "$port").
  Use it (start --port $port --reuse), stop it (emu.sh stop $port), or pick another port."
    fi
    port_listening $((port + 1)) && die "adb port $((port + 1)) is taken by pid $(lsof -nP -iTCP:$((port + 1)) -sTCP:LISTEN -t | head -1); pick another port"
    claim_port "$port" || die "port $port was just claimed by another emu.sh start; pick another port"
  else
    local p=$PORT_MIN
    while [ "$p" -le "$PORT_MAX" ]; do
      if [ -z "$(find_emulator_pid "$p")" ] && [ -z "$(adb_state "$p")" ] &&
        ! port_listening "$p" && ! port_listening $((p + 1)) && claim_port "$p"; then
        port="$p"
        break
      fi
      p=$((p + 2))
    done
    [ -n "$port" ] || die "no free emulator port in $PORT_MIN-$PORT_MAX"
  fi

  local serial="emulator-$port" dir logf pid
  dir="$(state_dir "$port")"
  logf="$dir/emulator.log"
  local args=(-avd "$avd" -read-only -no-snapshot-load -no-snapshot-save -no-audio -no-boot-anim
    -no-metrics -port "$port" -gpu "$gpu")
  [ "$window" = 1 ] || args+=(-no-window)

  # New session (setsid) so the emulator outlives this shell and its process group.
  nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec failed: $!\n"' \
    "$EMULATOR" "${args[@]}" >"$logf" 2>&1 </dev/null &
  pid=$!
  echo "$pid" >"$dir/pid"
  echo "$avd" >"$dir/avd"
  echo "$gpu" >"$dir/gpu"
  echo "$window" >"$dir/window"
  now >"$dir/started"
  echo "$REPO_ROOT" >"$dir/owner"
  rm -f "$dir/claimer"
  log "starting $serial (avd $avd, gpu $gpu, $([ "$window" = 1 ] && echo window || echo headless), pid $pid, log $logf)"

  local started booted=0
  started="$(now)"
  abort_start() {
    kill "$pid" 2>/dev/null || true
    sleep 2
    kill -9 "$pid" 2>/dev/null || true
    release_port "$port"
  }
  trap 'log "interrupted, stopping $serial"; abort_start; exit 130' INT TERM

  while [ $(($(now) - started)) -lt "$timeout" ]; do
    if ! pid_alive "$pid"; then
      echo "emu.sh: error: the emulator exited during boot. Last log lines ($logf):" >&2
      tail -n 40 "$logf" >&2 || true
      release_port "$port"
      exit 1
    fi
    if [ "$(device_prop "$serial" sys.boot_completed)" = "1" ]; then
      booted=1
      break
    fi
    sleep 1
  done
  if [ "$booted" != 1 ]; then
    echo "emu.sh: error: $serial did not finish booting within ${timeout}s. Last log lines ($logf):" >&2
    tail -n 40 "$logf" >&2 || true
    abort_start
    trap - INT TERM
    exit 1
  fi

  # sys.boot_completed can precede a usable package manager by a moment.
  local pm_deadline=$(($(now) + 60))
  until "$ADB" -s "$serial" shell pm path android 2>/dev/null | grep -q '^package:'; do
    [ "$(now)" -lt "$pm_deadline" ] || {
      log "warning: package manager on $serial not answering yet"
      break
    }
    sleep 1
  done

  # The guest network comes up a few seconds after boot_completed; until then the host
  # (10.0.2.2 = the Mac's loopback, where the test API listens) is "Network is unreachable".
  local net_deadline=$(($(now) + 60))
  until "$ADB" -s "$serial" shell 'ping -c 1 -W 1 10.0.2.2 >/dev/null 2>&1 && echo up' 2>/dev/null | grep -q up; do
    [ "$(now)" -lt "$net_deadline" ] || {
      log "warning: $serial cannot reach the host at 10.0.2.2 yet"
      break
    }
    sleep 1
  done

  # Idempotent test-friendly settings (the AVD has them baked in; re-applying costs ~1s).
  "$ADB" -s "$serial" shell '
    settings put global window_animation_scale 0
    settings put global transition_animation_scale 0
    settings put global animator_duration_scale 0
    svc power stayon true
    input keyevent KEYCODE_WAKEUP
    wm dismiss-keyguard' >/dev/null 2>&1 || log "warning: could not apply post-boot settings"

  trap - INT TERM
  echo "$(now)" >"$dir/booted"
  log "$serial ready in $(($(now) - started))s (API $(device_prop "$serial" ro.build.version.sdk_full), stop with: emu.sh stop $serial)"
  echo "$serial"
}

cmd_stop() {
  local target="" force=0 timeout=30
  while [ $# -gt 0 ]; do
    case "$1" in
      --force) force=1; shift ;;
      --timeout) timeout="${2:-}"; shift 2 ;;
      -h | --help) usage; exit 0 ;;
      -*) die "stop: unknown option '$1'" ;;
      *)
        [ -z "$target" ] || die "stop takes one serial or port"
        target="$1"
        shift
        ;;
    esac
  done
  [ -n "$target" ] || die "usage: emu.sh stop <serial|port> [--force]"
  need_tools
  local port serial pid owner
  port="$(parse_target "$target")"
  validate_port "$port"
  serial="emulator-$port"
  pid="$(find_emulator_pid "$port")"
  owner="$(state_get "$port" owner)"

  if [ -z "$pid" ] && [ -z "$(adb_state "$port")" ]; then
    release_port "$port"
    log "no emulator running on port $port"
    return 0
  fi
  if [ "$force" != 1 ]; then
    if [ -z "$owner" ]; then
      die "$serial was not started by emu.sh ($(describe_port "$port")); pass --force to stop it anyway"
    elif [ "$owner" != "$REPO_ROOT" ]; then
      die "$serial was started from another worktree ($owner); only its owner should stop it (or pass --force)"
    fi
  fi

  log "stopping $serial (pid ${pid:-?})"
  "$ADB" -s "$serial" emu kill >/dev/null 2>&1 || true
  local deadline=$(($(now) + timeout))
  while [ -n "$pid" ] && pid_alive "$pid" && [ "$(now)" -lt "$deadline" ]; do sleep 0.5; done
  if [ -n "$pid" ] && pid_alive "$pid" && pid_is_emulator_on_port "$pid" "$port"; then
    log "$serial ignored 'emu kill' for ${timeout}s, sending SIGTERM"
    kill "$pid" 2>/dev/null || true
    sleep 5
    if pid_alive "$pid" && pid_is_emulator_on_port "$pid" "$port"; then
      log "sending SIGKILL to $pid"
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  # adb keeps listing the serial as "offline" for a moment after the process exits.
  local gone_deadline=$(($(now) + 15))
  while [ -n "$(adb_state "$port")" ] && [ "$(now)" -lt "$gone_deadline" ]; do sleep 0.5; done
  release_port "$port"
  log "stopped $serial"
}

fmt_age() {
  local s="$1"
  if [ "$s" -ge 3600 ]; then
    echo "$((s / 3600))h$(((s % 3600) / 60))m"
  elif [ "$s" -ge 60 ]; then
    echo "$((s / 60))m$((s % 60))s"
  else
    echo "${s}s"
  fi
}

cmd_list() {
  need_tools
  local ports="" p
  # Union of: adb's emulator serials, emu.sh state dirs, and running qemu processes.
  ports="$("$ADB" devices 2>/dev/null | awk '$1 ~ /^emulator-[0-9]+$/ {sub("emulator-", "", $1); print $1}')"
  if [ -d "$STATE_ROOT" ]; then
    for p in "$STATE_ROOT"/*; do
      [ -d "$p" ] && ports="$ports
$(basename "$p")"
    done
  fi
  ports="$ports
$(ps -ax -o command= 2>/dev/null | awk '/qemu-system/ {for (i = 1; i < NF; i++) if ($i == "-port") print $(i + 1)}')"
  ports="$(echo "$ports" | grep -E '^[0-9]+$' | sort -un || true)"
  if [ -z "$ports" ]; then
    echo "no emulators running"
    return 0
  fi
  printf "%-15s %-9s %-10s %-7s %-8s %-7s %s\n" SERIAL STATE AVD PID UP BOOTED OWNER
  for p in $ports; do
    local pid state avd started up booted owner
    pid="$(find_emulator_pid "$p")"
    state="$(adb_state "$p")"
    avd="$(state_get "$p" avd)"
    started="$(state_get "$p" started)"
    owner="$(state_get "$p" owner)"
    if [ -z "$pid" ] && [ -z "$state" ]; then
      # A stale state dir (emulator died without `stop`): clean it up.
      release_port "$p"
      continue
    fi
    [ -n "$avd" ] || avd="$("$ADB" -s "emulator-$p" emu avd name 2>/dev/null | head -1 | tr -d '\r' || true)"
    up="-"
    [ -n "$started" ] && up="$(fmt_age $(($(now) - started)))"
    booted="no"
    [ "$state" = "device" ] && [ "$(device_prop "emulator-$p" sys.boot_completed)" = "1" ] && booted="yes"
    printf "%-15s %-9s %-10s %-7s %-8s %-7s %s\n" "emulator-$p" "${state:-none}" "${avd:-?}" "${pid:-?}" \
      "$up" "$booted" "${owner:-(not emu.sh)}"
  done
}

# GET a URL from inside the device with toybox nc (no curl/wget in the image) — handy to check
# that the app will reach an API: `emu.sh http emulator-5562 http://10.0.2.2:4961/api/health`.
cmd_http() {
  [ $# -eq 2 ] || die "usage: emu.sh http <serial|port> <http://host:port/path>"
  need_tools
  local port serial url hostport host hport path
  port="$(parse_target "$1")"
  serial="emulator-$port"
  url="$2"
  case "$url" in
    http://*) ;;
    *) die "only plain http:// URLs are supported, got '$url'" ;;
  esac
  hostport="${url#http://}"
  path="/${hostport#*/}"
  [ "$hostport" = "${hostport#*/}" ] && path="/"
  hostport="${hostport%%/*}"
  host="${hostport%%:*}"
  hport="${hostport##*:}"
  [ "$hport" = "$hostport" ] && hport=80
  # Keep stdin open briefly: an adb-reverse tunnel answers a beat after the request goes out.
  "$ADB" -s "$serial" shell "(printf 'GET $path HTTP/1.0\r\nHost: $hostport\r\nConnection: close\r\n\r\n'; sleep 1) | nc -w 5 -W 5 $host $hport" |
    tr -d '\r'
}

main() {
  local cmd="${1:-help}"
  [ $# -gt 0 ] && shift
  case "$cmd" in
    start) cmd_start "$@" ;;
    stop) cmd_stop "$@" ;;
    list | ls) cmd_list "$@" ;;
    http) cmd_http "$@" ;;
    help | -h | --help) usage ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
