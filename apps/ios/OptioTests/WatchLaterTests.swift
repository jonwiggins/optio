import ActivityKit
import AppIntents
import XCTest
@testable import Optio

/// **Later**, **Resume** and **Retry** on the Watch. A snoozed session stops needing
/// you and counts as running, as it does in the server's frame. The island's own update
/// after a tap (`WatchState.handling`) matches what the app's next reconcile computes,
/// so the island doesn't flip back.
final class WatchLaterTests: XCTestCase {
    private let now = Date(timeIntervalSinceReferenceDate: 811_400_000)

    private func item(_ id: String, _ state: String = "needs_you", ago minutes: Double, kind: WatchItem.Kind = .local,
                      snoozedFor snooze: Double? = nil, serverId: String? = nil) -> WatchItem {
        WatchItem(kind: kind, id: id, title: id, mono: id, reason: "Waiting on a permission",
                  since: now.addingTimeInterval(-minutes * 60), state: state, link: "optio://local/\(id)",
                  snoozedUntil: snooze.map { now.addingTimeInterval($0 * 60) }, serverId: serverId,
                  statusLabel: state == "needs_you" ? "needs you" : state)
    }

    private func snapshot(needsYou: [WatchItem], running: [WatchItem] = [], hostsOnline: Int = 1) -> NeedsYouSnapshot {
        NeedsYouSnapshot(needsYou: needsYou, running: running, hostsOnline: hostsOnline, hostsTotal: 1, asOf: now)
    }

    private func snoozed(_ item: WatchItem, until: Date) -> WatchItem {
        var item = item
        item.snoozedUntil = until
        return item
    }

    // MARK: Snoozed items in watchState()

    func testSnoozedItemLeavesTheQueueAndCountsAsRunning() {
        let older = item("older", ago: 10, snoozedFor: 15)
        let newer = item("newer", ago: 5)
        let busy = item("busy", "working", ago: 1)
        let state = snapshot(needsYou: [older, newer], running: [busy]).watchState()
        XCTAssertEqual(state.phase, .waiting)
        XCTAssertEqual(state.head?.id, "newer", "the snoozed item stops heading the Watch even though it is older")
        XCTAssertEqual(state.others, [])
        XCTAssertEqual(state.needsYouCount, 1)
        XCTAssertEqual(state.runningCount, 2)
    }

    func testSnoozingTheOnlyItemDropsTheWatchToWorking() {
        let state = snapshot(needsYou: [item("only", ago: 3, snoozedFor: 15)]).watchState()
        XCTAssertEqual(state.phase, .working)
        XCTAssertEqual(state.head?.id, "only")
        XCTAssertEqual(state.needsYouCount, 0)
        XCTAssertEqual(state.runningCount, 1)
    }

    func testWorkingHeadIsTheMostRecentOfRunningAndSnoozed() {
        let snoozedItem = item("snoozed", ago: 3, snoozedFor: 15)
        let busy = item("busy", "working", ago: 1)
        let state = snapshot(needsYou: [snoozedItem], running: [busy]).watchState()
        XCTAssertEqual(state.phase, .working)
        XCTAssertEqual(state.head?.id, "busy")
        XCTAssertEqual(state.runningCount, 2)
    }

    func testLapsedSnoozeNeedsYouAgain() {
        let state = snapshot(needsYou: [item("lapsed", ago: 30, snoozedFor: -1)]).watchState()
        XCTAssertEqual(state.phase, .waiting)
        XCTAssertEqual(state.head?.id, "lapsed")
        XCTAssertEqual(state.needsYouCount, 1)
        XCTAssertEqual(state.runningCount, 0)
    }

    func testOfflineFrameSkipsSnoozedItems() {
        let state = snapshot(needsYou: [item("snoozed", ago: 9, snoozedFor: 15), item("open", ago: 2)], hostsOnline: 0).watchState()
        XCTAssertEqual(state.phase, .offline)
        XCTAssertEqual(state.head?.id, "open")
        XCTAssertEqual(state.needsYouCount, 1)
        XCTAssertEqual(state.runningCount, 1)
    }

    func testWatchStatusTextSaysLaterWhileSnoozed() {
        XCTAssertEqual(item("a", ago: 1, snoozedFor: 5).watchStatusText(at: now), "later")
        XCTAssertEqual(item("a", ago: 1, snoozedFor: -5).watchStatusText(at: now), "needs you")
        XCTAssertEqual(item("a", ago: 1).watchStatusText(at: now), "needs you")
    }

    // MARK: The island's own update after a tap

    func testLaterOnTheLastItemMatchesTheNextReconcile() throws {
        let only = item("only", ago: 3)
        let before = snapshot(needsYou: [only]).watchState()
        let until = now.addingTimeInterval(15 * 60)
        let after = try XCTUnwrap(before.handling("only", at: now) { $0.snoozedUntil = until })
        XCTAssertEqual(after.phase, .working)
        XCTAssertEqual(after.head?.id, "only")
        XCTAssertEqual(after.head?.watchStatusText(at: now), "later")
        XCTAssertEqual(after.needsYouCount, 0)
        XCTAssertEqual(after.runningCount, 1)
        XCTAssertEqual(after, snapshot(needsYou: [snoozed(only, until: until)]).watchState(),
                       "the app's next reconcile computes the same frame, so nothing flips back")
    }

    func testLaterOnTheHeadPromotesTheNextOldest() throws {
        let (a, b, c, d) = (item("a", ago: 30), item("b", ago: 20), item("c", ago: 10), item("d", ago: 5))
        let before = snapshot(needsYou: [a, b, c, d]).watchState()
        XCTAssertEqual(before.head?.id, "a")
        XCTAssertEqual(before.others.map(\.id), ["b", "c"])

        let until = now.addingTimeInterval(15 * 60)
        let after = try XCTUnwrap(before.handling("a", at: now) { $0.snoozedUntil = until })
        XCTAssertEqual(after.phase, .waiting)
        XCTAssertEqual(after.head?.id, "b")
        XCTAssertEqual(after.others.map(\.id), ["c"], "d isn't in the frame; the next reconcile lists it")
        XCTAssertEqual(after.needsYouCount, 3)
        XCTAssertEqual(after.runningCount, before.runningCount + 1)

        let reconciled = snapshot(needsYou: [snoozed(a, until: until), b, c, d]).watchState()
        XCTAssertEqual(reconciled.head, after.head)
        XCTAssertEqual(reconciled.needsYouCount, after.needsYouCount)
        XCTAssertEqual(reconciled.runningCount, after.runningCount)
    }

    func testHandlingAnItemBehindTheHeadKeepsTheHead() throws {
        let before = snapshot(needsYou: [item("a", ago: 30), item("b", ago: 20), item("c", ago: 10)]).watchState()
        let after = try XCTUnwrap(before.handling("b", at: now))
        XCTAssertEqual(after.head?.id, "a")
        XCTAssertEqual(after.others.map(\.id), ["c"])
        XCTAssertEqual(after.needsYouCount, 2)
        XCTAssertEqual(after.runningCount, 1)
    }

    func testResumedTaskShowsQueued() throws {
        let task = item("t", "needs_attention", ago: 8, kind: .task)
        let before = snapshot(needsYou: [task]).watchState()
        let after = try XCTUnwrap(before.handling("t", at: now) {
            $0.state = "queued"
            $0.statusLabel = NeedsYouSnapshot.taskStatusLabel("queued")
            $0.reason = "Queued"
        })
        XCTAssertEqual(after.phase, .working)
        XCTAssertEqual(after.head?.state, "queued")
        XCTAssertEqual(after.head?.statusText, "queued")
        XCTAssertEqual(after.runningCount, 1)
    }

    func testHandlingNeedsAWaitingWatchThatShowsTheItem() {
        let waiting = snapshot(needsYou: [item("a", ago: 1)]).watchState()
        XCTAssertNil(waiting.handling("elsewhere", at: now), "an item the Watch doesn't show leaves the frame alone")
        let working = snapshot(needsYou: [], running: [item("r", "working", ago: 1)]).watchState()
        XCTAssertNil(working.handling("r", at: now))
    }

    func testActivityContentKeepsTheStaleAndRelevanceConventions() {
        let waiting = snapshot(needsYou: [item("a", ago: 1)]).watchState()
        let content = waiting.activityContent(at: now)
        XCTAssertEqual(content.staleDate, now.addingTimeInterval(90))
        XCTAssertEqual(content.relevanceScore, 100)
        XCTAssertEqual(WatchState(phase: .working).relevanceScore, 50)
        XCTAssertEqual(WatchState(phase: .offline).relevanceScore, 20)
        XCTAssertEqual(WatchState(phase: .done).relevanceScore, 0)
    }

    // MARK: The intents

    func testWatchButtonsRunInTheAppProcess() {
        // A plain AppIntent would run in the widget extension, which can't update the
        // activity: the tap would change nothing on the island until the next reconcile.
        let types: [any LiveActivityIntent.Type] = [LaterIntent.self, ResumeTaskIntent.self, WatchRetryTaskIntent.self]
        XCTAssertEqual(types.count, 3)
    }

    func testLaterIntentCarriesItsItem() {
        let intent = LaterIntent(item: item("t1", ago: 1, serverId: "srv-2"))
        XCTAssertEqual(intent.itemId, "t1")
        XCTAssertEqual(intent.kind, "local")
        XCTAssertEqual(intent.serverId, "srv-2")
    }
}
