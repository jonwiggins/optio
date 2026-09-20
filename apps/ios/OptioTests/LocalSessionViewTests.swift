import XCTest
@testable import Optio

/// Mirrors `apps/web/src/components/local/session-view.test.ts`, with the
/// phone's rule: the transcript is the default whenever there is one, live or not.
final class LocalSessionViewTests: XCTestCase {
    private typealias R = LocalSessionViewRule

    func testHonorsExplicitChoice() {
        XCTAssertEqual(R.resolve(choice: .screen, hasTranscript: true, loaded: true), .screen)
        XCTAssertEqual(R.resolve(choice: .transcript, hasTranscript: false, loaded: false), .transcript)
    }

    func testWaitsForTranscriptFetchBeforeDeciding() {
        XCTAssertNil(R.resolve(choice: nil, hasTranscript: false, loaded: false))
    }

    func testPrefersTranscriptWhileLiveAndWhenFinished() {
        XCTAssertEqual(R.resolve(choice: nil, hasTranscript: true, loaded: true), .transcript)
    }

    func testFallsBackToScreenWithoutTranscript() {
        // A plain shell, or an agent that hasn't said anything yet.
        XCTAssertEqual(R.resolve(choice: nil, hasTranscript: false, loaded: true), .screen)
    }
}
