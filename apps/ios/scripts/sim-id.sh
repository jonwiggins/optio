#!/usr/bin/env bash
# Prints the UDID of the simulator named $1, preferring a booted one.
# Names repeat across installed runtimes, so builds must target by id.
name="$1"
list=$(xcrun simctl list devices available | grep -F "$name (")
booted=$(echo "$list" | grep "(Booted)" | head -1 | grep -oE '[0-9A-F-]{36}')
[ -n "$booted" ] && { echo "$booted"; exit 0; }
echo "$list" | head -1 | grep -oE '[0-9A-F-]{36}'
