import XCTest

/// The Chat face opens at the end of the conversation, and a reader who has
/// scrolled up gets a floating "Scroll to the end" button that takes them back.
/// Needs a dev server and an *exited* terminal whose transcript is longer than
/// a screen (read-only: the Chat face resizes nothing and sends nothing):
///   OPTIO_UITEST_SERVER_URL, OPTIO_UITEST_TOKEN, OPTIO_UITEST_TERMINAL_ID
///   (optional OPTIO_UITEST_SHOT_DIR for PNGs)
final class TranscriptScrollUITests: XCTestCase {
    func testOpensAtEndAndJumpsBack() throws {
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
        if !toggle.waitForExistence(timeout: 4) {
            app.terminate()
            app.launch()
            sleep(8)
        }
        XCTAssertTrue(toggle.waitForExistence(timeout: 4), "view toggle not found")
        sleep(2)
        save(app.screenshot(), "1-opened")

        let jump = app.buttons["Scroll to the end"].firstMatch
        XCTAssertFalse(jump.exists, "opened at the end: no jump button yet")

        let log = app.scrollViews.firstMatch
        log.swipeDown()
        log.swipeDown()
        sleep(1)
        save(app.screenshot(), "2-scrolled-up")
        XCTAssertTrue(jump.waitForExistence(timeout: 3), "scrolled up: jump button shows")

        jump.tap()
        sleep(2)
        save(app.screenshot(), "3-jumped")
        XCTAssertFalse(jump.exists, "back at the end: jump button gone")
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
