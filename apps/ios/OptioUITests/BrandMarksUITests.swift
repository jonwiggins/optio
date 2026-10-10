import XCTest

/// Walks the surfaces that draw provider and trigger brand marks and saves
/// screenshots of them: the Connections hub scrolled to the Cloud / Other
/// providers (AWS, Pylon, PagerDuty) and the New work form's Starts row on
/// each event source. Needs a dev server:
///   OPTIO_UITEST_SERVER_URL, OPTIO_UITEST_TOKEN
/// The screenshots land in the test attachments (and, when
/// OPTIO_UITEST_SHOT_DIR is set, as PNG files in that directory).
final class BrandMarksUITests: XCTestCase {
    func testConnectionsCatalogMarks() throws {
        let app = try launch(openURL: "optio://section/connections")
        XCTAssertTrue(app.staticTexts["Notion"].waitForExistence(timeout: 10), "catalog did not load")
        // Scroll until the last catalog group is on screen.
        for _ in 0..<8 where !app.staticTexts["PagerDuty"].exists {
            app.swipeUp()
        }
        XCTAssertTrue(app.staticTexts["PagerDuty"].waitForExistence(timeout: 4), "PagerDuty provider not reached")
        sleep(1)
        save(app.screenshot(), "connections-catalog")
    }

    func testWorkFormStartsRowMarks() throws {
        for source in ["pylon", "datadog", "alertmanager"] {
            let app = try launch(openURL: "optio://work/new", extra: [
                "OPTIO_DEV_NEW_SESSION": "schedule",
                "OPTIO_DEV_NEW_SESSION_TWEAKS": "when=\(source),scroll=when",
            ])
            XCTAssertTrue(app.staticTexts["Starts"].waitForExistence(timeout: 10), "form did not open for \(source)")
            sleep(1)
            save(app.screenshot(), "form-\(source)")
            app.terminate()
        }
    }

    private func launch(openURL: String, extra: [String: String] = [:]) throws -> XCUIApplication {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["OPTIO_UITEST_SERVER_URL"], let token = env["OPTIO_UITEST_TOKEN"] else {
            throw XCTSkip("set OPTIO_UITEST_SERVER_URL / _TOKEN")
        }
        let app = XCUIApplication()
        app.launchEnvironment["OPTIO_DEV_SERVER_URL"] = server
        app.launchEnvironment["OPTIO_DEV_TOKEN"] = token
        app.launchEnvironment["OPTIO_DEV_NO_PUSH_PROMPT"] = "1"
        app.launchEnvironment["OPTIO_DEV_OPEN_URL"] = openURL
        for (k, v) in extra { app.launchEnvironment[k] = v }
        app.launch()
        return app
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
