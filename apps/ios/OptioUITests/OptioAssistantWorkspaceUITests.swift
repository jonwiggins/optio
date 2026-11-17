import XCTest

/// Run against scripts/agent-ui-fixture.mjs with
/// TEST_RUNNER_OPTIO_UITEST_AGENT_SERVER_URL=http://127.0.0.1:4978.
/// The fixture has no credentials, agent processes, or persistent side effects.
final class OptioAssistantWorkspaceUITests: XCTestCase {
    @MainActor
    func testSessionDirectoryDraftsDetailsQueueAndApproval() async throws {
        guard let server = ProcessInfo.processInfo.environment["OPTIO_UITEST_AGENT_SERVER_URL"],
              let url = URL(string: server), url.host == "127.0.0.1" else {
            throw XCTSkip("Start the isolated agent-ui-fixture and set OPTIO_UITEST_AGENT_SERVER_URL")
        }
        let (data, _) = try await URLSession.shared.data(from: url.appending(path: "/fixture"))
        XCTAssertEqual(try JSONSerialization.jsonObject(with: data) as? [String: String], ["fixture": "optio-agent-ui"])
        let app = XCUIApplication()
        app.launchArguments = ["--optio-ui-test-server=\(server)"]
        app.launch()
        let tab = app.tabBars.buttons["Optio Agent"]
        if tab.waitForExistence(timeout: 5) { tab.tap() }
        else { app.buttons["Optio Agent"].firstMatch.tap() }
        XCTAssertTrue(app.buttons["New session"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Plan the next release"].firstMatch.waitForExistence(timeout: 10))
        let table = app.descendants(matching: .any).matching(identifier: "markdown-table").firstMatch
        XCTAssertTrue(table.waitForExistence(timeout: 5))
        let lastCell = app.staticTexts["Verify shared history"]
        XCTAssertTrue(lastCell.exists)
        XCTAssertLessThanOrEqual(lastCell.frame.maxY, table.frame.maxY + 1, "Wrapped table cells must not be clipped")
        capture(app, "agent-conversation")
        openDirectory(app)
        let search = app.textFields["Find a session"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("slow builds")
        XCTAssertTrue(app.staticTexts["Investigate slow builds"].waitForExistence(timeout: 5))
        app.staticTexts["Investigate slow builds"].tap()
        let draft = app.descendants(matching: .any).matching(identifier: "Message to Optio").firstMatch
        XCTAssertTrue(draft.waitForExistence(timeout: 10))
        draft.tap()
        draft.typeText("A follow-up for this session")
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["Up next · 1"].waitForExistence(timeout: 5))
        app.buttons["keyboard.chevron.compact.down"].tap()
        app.buttons["Session details"].tap()
        XCTAssertFalse(app.buttons["Clear conversation"].isEnabled)
        XCTAssertFalse(app.buttons["End session"].isEnabled)
        app.buttons["Conversation"].tap()
        app.buttons["Cancel queued message"].tap()
        XCTAssertTrue(app.buttons["New session"].isEnabled)
        app.buttons["New session"].tap()
        XCTAssertTrue(app.staticTexts["What would you like to do?"].waitForExistence(timeout: 5))
        app.buttons["Help me start work on my machine"].tap()
        XCTAssertEqual(draft.value as? String, "Help me start work on my machine")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(draft.frame.maxY, app.keyboards.firstMatch.frame.minY)
        capture(app, "agent-keyboard")
        app.buttons["keyboard.chevron.compact.down"].tap()
        app.buttons["Session details"].tap()
        let name = app.textFields["Session name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap()
        // Clear using the field's current value; works without relying on edit menus.
        if let value = name.value as? String {
            name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
        }
        name.typeText("My release idea")
        app.buttons["Save name"].tap()
        XCTAssertTrue(app.staticTexts["My release idea"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(draft.value as? String, "Help me start work on my machine")
        openDirectory(app)
        if app.buttons["Clear search"].exists { app.buttons["Clear search"].tap() }
        capture(app, "agent-session-directory")
        app.staticTexts["Review the sign-in flow"].tap()
        let approve = app.buttons["Approve"]
        for _ in 0..<5 where !approve.isHittable { app.swipeUp() }
        XCTAssertTrue(approve.waitForExistence(timeout: 5))
        capture(app, "agent-approval")
        app.buttons["Decline"].tap()
        XCTAssertTrue(app.staticTexts["Declined"].waitForExistence(timeout: 5))
        openDirectory(app)
        app.staticTexts["My release idea"].tap()
        XCTAssertEqual(draft.value as? String, "Help me start work on my machine")
        app.buttons["Session details"].tap()
        capture(app, "agent-details")
        app.buttons["End session"].tap()
        XCTAssertTrue(app.alerts.buttons.matching(identifier: "Confirm end session").firstMatch.waitForExistence(timeout: 5))
        app.alerts.buttons.matching(identifier: "Confirm end session").firstMatch.tap()
        XCTAssertTrue(app.buttons["Session details"].waitForExistence(timeout: 5))
        openDirectory(app)
        XCTAssertFalse(app.staticTexts["My release idea"].exists)
    }

    @MainActor private func openDirectory(_ app: XCUIApplication) {
        if app.buttons["All sessions"].exists { app.buttons["All sessions"].tap() }
    }

    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
