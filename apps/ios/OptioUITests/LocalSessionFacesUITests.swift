import XCTest

/// Walks a Local session's two faces on a real terminal and saves screenshots:
/// Transcript (default), Screen sized for another device, the claim, and the
/// composer. Needs a dev server and a *throwaway* terminal id — the claim step
/// resizes its PTY and the composer types into it:
///   OPTIO_UITEST_SERVER_URL, OPTIO_UITEST_TOKEN, OPTIO_UITEST_TERMINAL_ID
///   (optional OPTIO_UITEST_TERMINAL_TITLE to navigate by row when the deep link
///   misses, OPTIO_UITEST_SHOT_DIR for PNGs, OPTIO_UITEST_MESSAGE to send)
final class LocalSessionFacesUITests: XCTestCase {
    func testTranscriptAndScreenFaces() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["OPTIO_UITEST_SERVER_URL"], let token = env["OPTIO_UITEST_TOKEN"], let terminal = env["OPTIO_UITEST_TERMINAL_ID"] else {
            throw XCTSkip("set OPTIO_UITEST_SERVER_URL / _TOKEN / _TERMINAL_ID")
        }
        let app = XCUIApplication()
        app.launchEnvironment["OPTIO_DEV_SERVER_URL"] = server
        app.launchEnvironment["OPTIO_DEV_TOKEN"] = token
        app.launchEnvironment["OPTIO_DEV_OPEN_URL"] = "optio://local/\(terminal)"
        app.launch()
        sleep(8)
        let toggle = app.segmentedControls.firstMatch
        // The dev deep link is best-effort (it can fire before the shell is up);
        // a second launch usually lands. Failing that, walk there by row title.
        if !toggle.waitForExistence(timeout: 4) {
            app.terminate()
            app.launch()
            sleep(8)
        }
        if !toggle.waitForExistence(timeout: 4), let title = env["OPTIO_UITEST_TERMINAL_TITLE"] {
            var row = app.staticTexts[title].firstMatch
            if !row.exists {
                app.tabBars.buttons["Work"].tap()
                row = app.staticTexts[title].firstMatch
            }
            XCTAssertTrue(row.waitForExistence(timeout: 8), "terminal row \(title) not found")
            row.tap()
            XCTAssertTrue(toggle.waitForExistence(timeout: 10), "view toggle not found after navigating")
            sleep(3)
        }
        XCTAssertTrue(toggle.exists, "view toggle not found")
        save(app.screenshot(), "1-transcript")

        let screen = toggle.buttons.element(boundBy: 1)
        screen.tap()
        sleep(4)
        save(app.screenshot(), "2-screen-passive")

        if let message = env["OPTIO_UITEST_MESSAGE"] {
            toggle.buttons.element(boundBy: 0).tap()
            sleep(1)
            let field = app.textFields["Message the agent"].firstMatch
            XCTAssertTrue(field.waitForExistence(timeout: 5), "composer not found")
            field.tap()
            field.typeText(message)
            app.buttons["Send"].firstMatch.tap()
            sleep(6)
            save(app.screenshot(), "3-after-send")
            screen.tap()
            sleep(3)
        }

        let claim = app.buttons["Use this screen"].firstMatch
        if claim.waitForExistence(timeout: 3) {
            claim.tap()
            sleep(3)
            save(app.screenshot(), "4-screen-claimed")
        }
    }

    private func save(_ shot: XCUIScreenshot, _ name: String) {
        let a = XCTAttachment(screenshot: shot)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["OPTIO_UITEST_SHOT_DIR"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }
}
