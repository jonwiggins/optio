import XCTest
@testable import Optio

@MainActor
final class OverviewWorkCardsTests: XCTestCase {
    func testAttentionTaskUsesTheFullFeedCardWhenAvailable() {
        let model = OverviewModel()
        model.recentTasks = [DashRecentTask(id: "task", title: "Dashboard title", state: "needs_attention")]
        let rows = WorkFeed.collect(.init(unified: [.init(type: "repo-task", id: "task", title: "Feed title", state: "needs_attention", agentType: "codex", prUrl: "https://github.com/acme/app/pull/42")]))
        XCTAssertEqual(model.needsYouRows(feed: rows), rows)
    }

    func testAttentionTaskFallbackKeepsRuntimePRAndNavigation() {
        let model = OverviewModel()
        model.recentTasks = [
            DashRecentTask(id: "task", title: "Review this", state: "needs_attention", agentType: "gemini", prUrl: "https://github.com/acme/app/pull/42"),
            DashRecentTask(id: "done", state: "completed"),
        ]
        let rows = model.needsYouRows(feed: [])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.who, "gemini")
        XCTAssertEqual(rows.first?.destination, .task("task"))
        XCTAssertEqual(rows.first?.links.first?.label, "#42")
    }
}
