#!/usr/bin/env bash
# Compiles OptioWidgets/Widgets/GlancePolicy.swift + GlanceCopy.swift with bare swiftc
# and runs their assertions. The widget extension is not linked into OptioTests, so the
# pure timeline decisions and the Sessions copy are tested here instead.
# Usage: scripts/test-glance-policy.sh
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

// ── GlanceCopy: Sessions vocabulary ──

// Counts line
check(GlanceCopy.countsLine(needsYou: 2, running: 3) == "2 need you · 3 running", "counts line")
check(GlanceCopy.countsLine(needsYou: 1, running: 0) == "1 needs you", "singular needs you")
check(GlanceCopy.countsLine(needsYou: 0, running: 1) == "1 running", "running only")
check(GlanceCopy.countsLine(needsYou: 0, running: 0) == "Quiet", "quiet")
check(GlanceCopy.countsLine(needsYou: 3, running: 2, excludingHead: true) == "2 more need you · 2 running", "more need you under a head")
check(GlanceCopy.countsLine(needsYou: 2, running: 0, excludingHead: true) == "1 more needs you", "singular more")
check(GlanceCopy.countsLine(needsYou: 1, running: 0, excludingHead: true) == "", "nothing beyond the head → empty")
check(GlanceCopy.countsLine(needsYou: 1, running: 3, excludingHead: true) == "3 running", "only running beyond the head")

// Headline count: needs-you wins, then running, then nil
check(GlanceCopy.headlineCount(needsYou: 2, running: 5)! == (2, "need you"), "needs you wins")
check(GlanceCopy.headlineCount(needsYou: 1, running: 5)! == (1, "needs you"), "singular")
check(GlanceCopy.headlineCount(needsYou: 0, running: 5)! == (5, "running"), "running when nothing needs you")
check(GlanceCopy.headlineCount(needsYou: 0, running: 0) == nil, "nil when quiet")

// Live Activity headline / compact / working line
check(GlanceCopy.headline(phase: "waiting", needsYou: 1, running: 0) == "1 session needs you", "waiting singular")
check(GlanceCopy.headline(phase: "waiting", needsYou: 3, running: 2) == "3 sessions need you", "waiting plural")
check(GlanceCopy.headline(phase: "working", needsYou: 0, running: 3) == "Nothing needs you · 3 running", "working")
check(GlanceCopy.headline(phase: "working", needsYou: 0, running: 0) == "Nothing needs you", "working, none")
check(GlanceCopy.headline(phase: "offline", needsYou: 0, running: 0) == "Machine unreachable", "offline")
check(GlanceCopy.headline(phase: "done", needsYou: 0, running: 0) == "Sessions ended", "done")
check(GlanceCopy.compactTrailing(phase: "waiting", needsYou: 3, running: 0) == "+2", "compact +2")
check(GlanceCopy.compactTrailing(phase: "waiting", needsYou: 1, running: 0) == "", "compact single → empty")
check(GlanceCopy.compactTrailing(phase: "working", needsYou: 0, running: 4) == "4", "compact running")
check(GlanceCopy.workingLine(running: 0) == "quiet", "working line 0")
check(GlanceCopy.workingLine(running: 1) == "1 session running", "working line 1")
check(GlanceCopy.workingLine(running: 3) == "3 sessions running", "working line 3")

// Inline
check(GlanceCopy.inline(prefix: "Optio", headName: "web", headWord: "Allow?", needsYou: 3, running: 1) == "Optio · web Allow? +2", "inline +2")
check(GlanceCopy.inline(prefix: "Optio", headName: "web", headWord: nil, needsYou: 1, running: 1) == "Optio · web needs you", "inline default word")
check(GlanceCopy.inline(prefix: "Optio", headName: nil, headWord: nil, needsYou: 0, running: 2) == "Optio · 2 running", "inline running")
check(GlanceCopy.inline(prefix: "Optio · MBP", headName: nil, headWord: nil, needsYou: 0, running: 0) == "Optio · MBP · quiet", "inline quiet")

// Board tiles: two without server counts, five with
let two = GlanceCopy.tiles(needsYou: 1, running: 2, waiting: nil, recurring: nil, agents: nil)
check(two.map(\.id) == [.needsYou, .running], "legacy server → two tiles: \(two.map(\.id))")
let five = GlanceCopy.tiles(needsYou: 1, running: 2, waiting: 3, recurring: 4, agents: 5)
check(five.map(\.id) == GlanceCopy.Tile.Id.allCases, "five tiles in board order")
check(five.map(\.count) == [1, 2, 3, 4, 5], "tile counts")
check(five.map(\.view) == ["active", "active", "active", "recurring", "agents"], "tile views")
check(five.map(\.label) == ["Need you", "Running", "Waiting", "Recurring", "Agents"], "tile labels")

// Chips
check(GlanceCopy.whoLabel("claude-code") == "Claude Code", "who label")
check(GlanceCopy.whoLabel("terminal") == "terminal", "terminal stays")
check(GlanceCopy.whoLabel("mystery") == "mystery", "unknown runtime passes through")
check(GlanceCopy.whereLabel("MacBook Pro · ~/repos/optio/apps/web", target: "machine", short: true) == "MacBook Pro · web", "where short keeps host + leaf")
check(GlanceCopy.whereLabel("MacBook Pro · ~/repos/optio/apps/web", target: "machine", short: false) == "MacBook Pro · ~/repos/optio/apps/web", "where long verbatim")
check(GlanceCopy.whereLabel("jonwiggins/optio", target: "pod", short: true) == "optio", "repo short → leaf")
check(GlanceCopy.whereLabel("@vesper", target: "pod", short: true) == "@vesper", "slug unchanged")
check(GlanceCopy.whereLabel(nil, target: "pod", short: true) == "Optio pod", "pod fallback")
check(GlanceCopy.whereLabel("", target: "machine", short: true) == "machine", "machine fallback")

if failures == 0 { print("GlancePolicy + GlanceCopy: all checks passed") } else { print("GlancePolicy + GlanceCopy: \(failures) failure(s)"); exit(1) }
SWIFT
xcrun swiftc -O -o "$tmp/policy" OptioWidgets/Widgets/GlancePolicy.swift OptioWidgets/Widgets/GlanceCopy.swift "$tmp/main.swift"
"$tmp/policy"
