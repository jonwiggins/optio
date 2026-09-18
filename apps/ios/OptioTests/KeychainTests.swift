import XCTest
@testable import Optio

final class KeychainTests: XCTestCase {
    func testRoundTrip() throws {
        let account = "test-\(UUID().uuidString)"
        defer { Keychain.delete(account: account) }
        try Keychain.set("first", account: account)
        XCTAssertEqual(Keychain.get(account: account), "first")
        try Keychain.set("second", account: account)
        XCTAssertEqual(Keychain.get(account: account), "second")
        Keychain.delete(account: account)
        XCTAssertNil(Keychain.get(account: account))
    }
}
