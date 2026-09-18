import XCTest
@testable import Optio

final class APIClientTests: XCTestCase {
    func testWsURLSwapsScheme() {
        let api = APIClient()
        api.configure(baseURL: URL(string: "https://optio.example:30400")!, token: "t", workspaceId: nil)
        XCTAssertEqual(api.wsURL("/ws/events").absoluteString, "wss://optio.example:30400/ws/events")
        api.configure(baseURL: URL(string: "http://mac.tail.ts.net:30400")!, token: "t", workspaceId: nil)
        XCTAssertEqual(api.wsURL("/ws/events").absoluteString, "ws://mac.tail.ts.net:30400/ws/events")
    }

    func testDateDecoding() throws {
        let api = APIClient()
        struct Row: Decodable { var at: Date }
        let json = #"{"at":"2026-09-17T10:20:30.123Z"}"#.data(using: .utf8)!
        XCTAssertNoThrow(try api.decoder.decode(Row.self, from: json))
        let plain = #"{"at":"2026-09-17T10:20:30Z"}"#.data(using: .utf8)!
        XCTAssertNoThrow(try api.decoder.decode(Row.self, from: plain))
    }
}
