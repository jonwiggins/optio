import XCTest
@testable import Optio

/// What the Watch lists under its tiles: one session waiting on you is shown in detail;
/// two or three are listed, oldest first; past three, the oldest two and a "+N more"
/// line (three rows and the line would overflow the lock screen). With nothing waiting
/// the running sessions are listed the same way, newest first. WidgetSnapshots checks
/// the rendering (`testLiveActivityFitsItsHeight`).
final class WatchListTests: XCTestCase {
    private let now = Date(timeIntervalSinceReferenceDate: 811_400_000)

    private func item(_ id: String, _ state: String = "needs_you", ago minutes: Double) -> WatchItem {
        WatchItem(kind: .local, id: id, title: id, mono: id, since: now.addingTimeInterval(-minutes * 60), state: state, link: "optio://local/\(id)")
    }

    /// `n` sessions needing you (n0 oldest) and `running` working ones, as the app computes the frame.
    private func state(needsYou n: Int, running: Int = 0) -> WatchState {
        let needs = (0..<n).map { item("n\($0)", ago: Double(60 - $0)) }
        let busy = (0..<running).map { item("r\($0)", "working", ago: Double($0)) }
        return NeedsYouSnapshot(needsYou: needs, running: busy, hostsOnline: 1, hostsTotal: 1, asOf: now).watchState()
    }

    func testOneWaitingOnYouIsShownInDetail() {
        let s = state(needsYou: 1, running: 2)
        XCTAssertFalse(s.listsRows)
        XCTAssertEqual(s.queue.map(\.id), ["n0"])
        XCTAssertEqual(s.unlisted, 0)
    }

    func testTwoOrThreeAreAllListedOldestFirst() {
        XCTAssertTrue(state(needsYou: 2).listsRows)
        XCTAssertEqual(state(needsYou: 2).listed.map(\.id), ["n0", "n1"])
        XCTAssertEqual(state(needsYou: 3).listed.map(\.id), ["n0", "n1", "n2"])
        XCTAssertEqual(state(needsYou: 3).unlisted, 0)
    }

    func testPastThreeTheOldestTwoAreListedAndTheRestCounted() {
        let s = state(needsYou: 12, running: 4)
        XCTAssertEqual(s.queue.count, 3, "a frame carries three")
        XCTAssertEqual(s.listed.map(\.id), ["n0", "n1"])
        XCTAssertEqual(s.unlisted, 10)
        XCTAssertEqual(s.runningCount, 4)
    }

    func testWhileSomethingWaitsOnlyItIsListed() {
        let s = state(needsYou: 2, running: 5)
        XCTAssertEqual(s.listed.map(\.id), ["n0", "n1"], "running sessions are counted, not listed")
        XCTAssertEqual(s.unlisted, 0)
    }

    func testWithNothingWaitingTheRunningSessionsAreListedNewestFirst() {
        let s = state(needsYou: 0, running: 2)
        XCTAssertEqual(s.phase, .working)
        XCTAssertTrue(s.listsRows)
        XCTAssertEqual(s.listed.map(\.id), ["r0", "r1"])
        XCTAssertEqual(s.unlisted, 0)
        XCTAssertEqual(s.queue, [], "none of them waits on you")
    }

    func testPastThreeRunningTheNewestTwoAreListed() {
        let s = state(needsYou: 0, running: 5)
        XCTAssertEqual(s.rows.map(\.id), ["r0", "r1", "r2"], "a frame carries three")
        XCTAssertEqual(s.listed.map(\.id), ["r0", "r1"])
        XCTAssertEqual(s.unlisted, 3)
    }

    func testOneRunningIsShownInDetail() {
        let s = state(needsYou: 0, running: 1)
        XCTAssertFalse(s.listsRows)
        XCTAssertEqual(s.head?.id, "r0")
    }

    func testNothingIsListedOfflineOrOnceEnded() {
        let offline = NeedsYouSnapshot(needsYou: [item("n0", ago: 5)], running: [item("r0", "working", ago: 1)], hostsOnline: 0, hostsTotal: 1, asOf: now).watchState()
        XCTAssertEqual(offline.phase, .offline)
        XCTAssertEqual(offline.rows, [])
        XCTAssertEqual(WatchState(phase: .done, summary: "Quiet.").rows, [])
    }

    func testLaterOnAListedRowTakesItOffTheList() {
        let next = state(needsYou: 4).handling("n1", at: now)!
        XCTAssertEqual(next.needsYouCount, 3)
        XCTAssertEqual(next.listed.map(\.id), ["n0", "n2"], "n2 rode in the frame; n3 comes with the next reconcile")
        XCTAssertEqual(next.unlisted, 1)
    }

    func testLaterDownToOneShowsItInDetail() {
        let next = state(needsYou: 2).handling("n0", at: now)!
        XCTAssertFalse(next.listsRows)
        XCTAssertEqual(next.head?.id, "n1")
    }
}
