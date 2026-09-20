import XCTest
@testable import Optio

/// Mirrors `apps/web/src/components/local/stream-policy.test.ts`.
final class LocalStreamPolicyTests: XCTestCase {
    private typealias P = StreamPolicy

    func testReconnectsOn4503HostDisconnected() {
        XCTAssertEqual(P.closeAction(code: 4503, terminalDead: false, retryRequested: false), .reconnect)
    }

    func testReconnectsOnAbnormalAndGoingAway() {
        for code in [1001, 1006] {
            XCTAssertEqual(P.closeAction(code: code, terminalDead: false, retryRequested: false), .reconnect)
        }
    }

    func testStopsWithMessageOnPermanentRejections() {
        for code in [4401, 4403, 4429] {
            XCTAssertEqual(
                P.closeAction(code: code, terminalDead: false, retryRequested: false),
                .stop(message: P.permanentCloseMessages[code])
            )
        }
    }

    func testPermanentRejectionsWinOverRetryRequest() {
        XCTAssertEqual(
            P.closeAction(code: 4403, terminalDead: false, retryRequested: true),
            .stop(message: P.permanentCloseMessages[4403])
        )
    }

    func testNeverReconnectsOnceTerminalIsDead() {
        for code in [1000, 1006, 4503] {
            XCTAssertEqual(P.closeAction(code: code, terminalDead: true, retryRequested: false), .stop(message: nil))
        }
    }

    func testDoesNotLoopOnDeliberateNormalCloses() {
        for code in [1000, 1005] {
            XCTAssertEqual(P.closeAction(code: code, terminalDead: false, retryRequested: false), .stop(message: nil))
        }
    }

    func testSelfInitiatedRetryCloseReconnects() {
        XCTAssertEqual(P.closeAction(code: 1000, terminalDead: false, retryRequested: true), .reconnect)
    }

    func testOnlyExitedAndErrorAreDead() {
        XCTAssertTrue(P.isTerminalStateDead(.exited))
        XCTAssertTrue(P.isTerminalStateDead(.error))
        XCTAssertFalse(P.isTerminalStateDead(.running))
        XCTAssertFalse(P.isTerminalStateDead(.launching))
        XCTAssertFalse(P.isTerminalStateDead(.pending))
    }
}
