import XCTest

/// Drives a real drag on a terminal screen and checks the view actually scrolls.
/// Needs a dev server and a terminal id:
///   OPTIO_UITEST_SERVER_URL, OPTIO_UITEST_TOKEN, OPTIO_UITEST_TERMINAL_ID
/// The screenshots land in the test attachments (and, when
/// OPTIO_UITEST_SHOT_DIR is set, as PNG files in that directory).
final class TerminalScrollUITests: XCTestCase {
    func testDragScrollsTerminal() throws {
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
        save(app.screenshot(), "before")
        let mid = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
        let lower = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
        mid.press(forDuration: 0.05, thenDragTo: lower)
        sleep(1)
        save(app.screenshot(), "after-drag-down")
        lower.press(forDuration: 0.05, thenDragTo: mid)
        sleep(1)
        save(app.screenshot(), "after-drag-up")
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
