import XCTest
@testable import Optio

/// Mirrors `apps/web/src/components/local/sizing.test.ts`.
final class TerminalSizingTests: XCTestCase {
    private typealias S = TerminalSizing
    private let laptop = TerminalGrid(cols: 160, rows: 45)
    private let phone = TerminalGrid(cols: 45, rows: 30)

    // MARK: passiveFontPt

    func testShrinksFontSoOversizeGridFitsWidth() {
        // 390pt phone, 160-col laptop grid, 0.6 cell ratio → 4.06 → floored 4 → clamped to 5
        XCTAssertEqual(S.passiveFontPt(availableWidth: 390, cols: 160, cellWidthPerPt: 0.6), 5)
        // 1000pt, 120 cols → 13.8 → capped at the base (12 on iOS)
        XCTAssertEqual(S.passiveFontPt(availableWidth: 1000, cols: 120, cellWidthPerPt: 0.6), 12)
        // 600pt, 120 cols → 8.3 → 8
        XCTAssertEqual(S.passiveFontPt(availableWidth: 600, cols: 120, cellWidthPerPt: 0.6), 8)
        // Same arithmetic as the web at its 13px base.
        XCTAssertEqual(S.passiveFontPt(availableWidth: 1000, cols: 120, cellWidthPerPt: 0.6, base: 13), 13)
    }

    func testNeverGrowsPastBaseForSmallGrid() {
        XCTAssertEqual(S.passiveFontPt(availableWidth: 1600, cols: 40, cellWidthPerPt: 0.6), 12)
    }

    func testFallsBackToBaseOnDegenerateInput() {
        XCTAssertEqual(S.passiveFontPt(availableWidth: 0, cols: 120, cellWidthPerPt: 0.6), 12)
        XCTAssertEqual(S.passiveFontPt(availableWidth: 600, cols: 0, cellWidthPerPt: 0.6), 12)
        XCTAssertEqual(S.passiveFontPt(availableWidth: 600, cols: 120, cellWidthPerPt: 0), 12)
    }

    // MARK: onGridAnnounced

    func testStaysUnclaimedWhenPtyMatchesNaturalFit() {
        XCTAssertEqual(S.onGridAnnounced(.unclaimed, laptop, natural: laptop, sent: []), .unclaimed)
    }

    func testGoesPassiveWhenAnotherViewersGridArrives() {
        XCTAssertEqual(S.onGridAnnounced(.unclaimed, phone, natural: laptop, sent: []), .passive(phone))
    }

    func testKeepsOwnershipWhenOwnRequestEchoes() {
        XCTAssertEqual(S.onGridAnnounced(.owner, laptop, natural: laptop, sent: [laptop]), .owner)
    }

    func testKeepsOwnershipOnStaleEchoOfEarlierRequest() {
        let first = TerminalGrid(cols: 143, rows: 54)
        let second = TerminalGrid(cols: 143, rows: 56)
        var sent = S.pushSentGrid([], first)
        sent = S.pushSentGrid(sent, second)
        XCTAssertEqual(S.onGridAnnounced(.owner, first, natural: second, sent: sent), .owner)
        sent = S.ackSentGrid(sent, first)!
        XCTAssertEqual(sent, [second])
        XCTAssertEqual(S.onGridAnnounced(.owner, second, natural: second, sent: sent), .owner)
        XCTAssertEqual(S.ackSentGrid(sent, second), [])
        // A grid we never asked for matches nothing.
        XCTAssertNil(S.ackSentGrid(sent, phone))
    }

    func testCapsPendingQueueWhenDaemonNeverEchoes() {
        var sent: [TerminalGrid] = []
        for i in 0..<100 { sent = S.pushSentGrid(sent, TerminalGrid(cols: 80 + i, rows: 24)) }
        XCTAssertEqual(sent.count, 32)
        XCTAssertEqual(sent.first, TerminalGrid(cols: 148, rows: 24))
    }

    func testLosesOwnershipWhenSomeoneElseResizes() {
        XCTAssertEqual(S.onGridAnnounced(.owner, phone, natural: laptop, sent: [laptop]), .passive(phone))
    }

    func testReturnsToUnclaimedWhenPtyComesBackToNaturalFit() {
        XCTAssertEqual(S.onGridAnnounced(.passive(phone), laptop, natural: laptop, sent: []), .unclaimed)
    }

    func testPinsRecordedGridEvenWhenItMatchesNaturalFit() {
        XCTAssertEqual(S.onGridAnnounced(.unclaimed, laptop, natural: laptop, sent: [], recorded: true), .passive(laptop))
        XCTAssertEqual(S.onGridAnnounced(.owner, laptop, natural: laptop, sent: [laptop], recorded: true), .passive(laptop))
    }
}
