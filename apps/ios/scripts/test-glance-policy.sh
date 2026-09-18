#!/usr/bin/env bash
# Compiles OptioWidgets/Widgets/GlancePolicy.swift with bare swiftc and runs its
# assertions. The widget extension is not linked into OptioTests, so the pure
# timeline decisions are tested here instead. Usage: scripts/test-glance-policy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/main.swift" <<'SWIFT'
import Foundation

var failures = 0
func check(_ cond: Bool, _ msg: String, line: Int = #line) {
    if !cond { failures += 1; print("FAIL line \(line): \(msg)") }
}
let now = Date(timeIntervalSince1970: 1_800_000_000)
let m = 60.0

// Refresh cadence
check(GlancePolicy.refreshInterval(.live, anyRunning: true, anyNeedsYou: false) == 5 * m, "5 min while running")
check(GlancePolicy.refreshInterval(.live, anyRunning: false, anyNeedsYou: true) == 5 * m, "5 min while waiting")
check(GlancePolicy.refreshInterval(.live, anyRunning: false, anyNeedsYou: false) == 15 * m, "15 min when quiet")
check(GlancePolicy.refreshInterval(.signedOut, anyRunning: true, anyNeedsYou: true) == 60 * m, "60 min signed out")
check(GlancePolicy.refreshInterval(.unreachable, anyRunning: true, anyNeedsYou: true) == 60 * m, "60 min unreachable")

// Staleness
check(!GlancePolicy.isStale(asOf: now.addingTimeInterval(-19 * m), now: now), "19 min is fresh")
check(GlancePolicy.isStale(asOf: now.addingTimeInterval(-21 * m), now: now), "21 min is stale")

// Snooze ordering: snoozed items go to the back, order preserved within groups, expired snoozes ignored
let items = ["web", "api", "cli", "docs"]
let snoozes = ["web": now.addingTimeInterval(10 * m), "cli": now.addingTimeInterval(-1)]
let ordered = GlancePolicy.applySnooze(items, id: { $0 }, snoozedUntil: snoozes, now: now)
check(ordered == ["api", "cli", "docs", "web"], "snoozed to back: \(ordered)")
check(GlancePolicy.applySnooze(items, id: { $0 }, snoozedUntil: [:], now: now) == items, "no snoozes → unchanged")
check(GlancePolicy.applySnooze([String](), id: { $0 }, snoozedUntil: snoozes, now: now).isEmpty, "empty stays empty")

// Run widget flashes
check(GlancePolicy.showsStarted(lastStartedAt: now.addingTimeInterval(-2), now: now), "started 2 s ago shows")
check(!GlancePolicy.showsStarted(lastStartedAt: now.addingTimeInterval(-61), now: now), "started 61 s ago hides")
check(!GlancePolicy.showsStarted(lastStartedAt: nil, now: now), "never started hides")
check(GlancePolicy.isArmed(armedAt: now.addingTimeInterval(-3), now: now), "armed 3 s ago")
check(!GlancePolicy.isArmed(armedAt: now.addingTimeInterval(-11), now: now), "arm expired")

// Wait text
check(GlancePolicy.waitText(since: now.addingTimeInterval(-30), now: now) == "now", "seconds → now")
check(GlancePolicy.waitText(since: now.addingTimeInterval(-4 * m), now: now) == "4m", "4m")
check(GlancePolicy.waitText(since: now.addingTimeInterval(-2 * 3600), now: now) == "2h", "2h")
check(GlancePolicy.waitText(since: now.addingTimeInterval(-3 * 86400), now: now) == "3d", "3d")

if failures == 0 { print("GlancePolicy: all checks passed") } else { print("GlancePolicy: \(failures) failure(s)"); exit(1) }
SWIFT
xcrun swiftc -O -o "$tmp/policy" OptioWidgets/Widgets/GlancePolicy.swift "$tmp/main.swift"
"$tmp/policy"
