import XCTest
@testable import Optio

/// Who may create and change work: members and admins; a viewer is read-only.
/// An unknown role (auth disabled, an older server) counts as allowed, as on
/// Android and the web, so the New work entry points never flicker.
final class RolesTests: XCTestCase {
    private func user(role: String?) throws -> CurrentUser {
        var json: [String: Any] = ["id": "u1"]
        if let role { json["workspaceRole"] = role }
        let data = try JSONSerialization.data(withJSONObject: json)
        return try JSONDecoder().decode(CurrentUser.self, from: data)
    }

    func testViewersAreReadOnly() throws {
        let viewer = try user(role: "viewer")
        XCTAssertTrue(viewer.isViewer)
        XCTAssertFalse(viewer.canMutate)
        XCTAssertFalse(viewer.isAdmin)
    }

    func testMembersAdminsAndUnknownRolesMayCreateWork() throws {
        XCTAssertTrue(try user(role: "member").canMutate)
        XCTAssertTrue(try user(role: "admin").canMutate)
        let unknown = try user(role: nil)
        XCTAssertTrue(unknown.canMutate)
        XCTAssertFalse(unknown.isViewer)
    }
}
