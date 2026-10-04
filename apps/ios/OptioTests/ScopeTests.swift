import XCTest
@testable import Optio

/// Organization / Private / Other people's: the one grouping every scoped list
/// uses (`Features/More/Scope.swift`, the web's `lib/owner.ts`).
final class ScopeTests: XCTestCase {
    func testScopeOfOwnerForMembersAndAdmins() {
        XCTAssertEqual(OwnerScope.of(ownerUserId: nil, viewerId: "me", isAdmin: true), .organization)
        XCTAssertEqual(OwnerScope.of(ownerUserId: "", viewerId: "me", isAdmin: true), .organization)
        XCTAssertEqual(OwnerScope.of(ownerUserId: "me", viewerId: "me", isAdmin: true), .private)
        XCTAssertEqual(OwnerScope.of(ownerUserId: "them", viewerId: "me", isAdmin: true), .others)
        // A member only ever receives their own private rows.
        XCTAssertEqual(OwnerScope.of(ownerUserId: "them", viewerId: "me", isAdmin: false), .private)
        // No viewer id yet (auth disabled, /api/auth/me pending): private reads as the viewer's.
        XCTAssertEqual(OwnerScope.of(ownerUserId: "them", viewerId: nil, isAdmin: true), .private)
    }

    func testGroupsKeepOrderAndShowOthersOnlyWhenPresent() {
        struct R { let id: String; let owner: String? }
        let rows = [R(id: "a", owner: nil), R(id: "b", owner: "me"), R(id: "c", owner: "them"), R(id: "d", owner: nil)]

        let admin = ScopeGroups.group(rows, viewerId: "me", isAdmin: true, owner: \.owner)
        XCTAssertEqual(admin.organization.map(\.id), ["a", "d"])
        XCTAssertEqual(admin.private.map(\.id), ["b"])
        XCTAssertEqual(admin.others.map(\.id), ["c"])
        XCTAssertEqual(admin.sections.map(\.scope), [.organization, .private, .others])
        XCTAssertEqual(admin.count, 4)

        let member = ScopeGroups.group(rows, viewerId: "me", isAdmin: false, owner: \.owner)
        XCTAssertEqual(member.sections.map(\.scope), [.organization, .private], "a member never sees Other people's")
        XCTAssertEqual(member.private.map(\.id), ["b", "c"])

        let none = ScopeGroups.group([R](), viewerId: "me", isAdmin: true, owner: \.owner)
        XCTAssertTrue(none.isEmpty)
        XCTAssertEqual(none.sections.map(\.scope), [.organization, .private], "empty sections still say what each scope means")
    }

    func testRulesFollowTheServer() {
        XCTAssertTrue(ScopeRules.canChange(.organization, orgRule: true))
        XCTAssertFalse(ScopeRules.canChange(.organization, orgRule: false))
        XCTAssertTrue(ScopeRules.canChange(.private, orgRule: false))
        XCTAssertFalse(ScopeRules.canChange(.others, orgRule: true))
        XCTAssertTrue(ScopeRules.canDelete(.others, orgRule: false, isAdmin: true), "admins delete other people's, for offboarding")
        XCTAssertFalse(ScopeRules.canDelete(.others, orgRule: true, isAdmin: false))
        XCTAssertFalse(ScopeRules.canDelete(.organization, orgRule: false, isAdmin: false))
    }

    func testPrivateTagText() {
        XCTAssertNil(PrivateTag(scope: .organization).text)
        XCTAssertEqual(PrivateTag(scope: .private).text, "Private")
        XCTAssertEqual(PrivateTag(scope: .others, ownerName: "Jane").text, "Private · Jane")
        XCTAssertEqual(PrivateTag(scope: .others).text, "Private · someone")
        XCTAssertEqual(PrivateTag(ownerUserId: "them", ownerName: "Jane", viewerId: "me", isAdmin: true).text, "Private · Jane")
    }

    func testOwnerPickerHint() {
        XCTAssertEqual(OwnerPicker.hint(owner: .workspace, what: "secret", canOrg: false), "Only an admin can make a secret the organization's.")
        XCTAssertTrue(OwnerPicker.hint(owner: .me, what: "secret").hasPrefix("Only you see this secret"))
        XCTAssertEqual(OwnerPicker.hint(owner: .workspace, what: "secret", orgHint: "Org."), "Org.")
    }

    func testWorkFeedCarriesTheOwnerThrough() {
        let rows = WorkFeed.collect(WorkFeed.Sources(
            unified: [
                WorkFeed.UnifiedRow(type: "repo-task", id: "t1", title: "Mine", state: "running", ownerUserId: "me", ownerName: "Me"),
                WorkFeed.UnifiedRow(type: "standalone", id: "j1", name: "Org job", enabled: true),
            ],
            agents: [WorkFeed.AgentRow(id: "pa1", name: "Forge", state: "idle", ownerUserId: "them", ownerName: "Jane")]
        ))
        XCTAssertEqual(rows.first { $0.key == "task-t1" }?.ownerUserId, "me")
        XCTAssertEqual(rows.first { $0.key == "task-t1" }?.ownerName, "Me")
        XCTAssertNil(rows.first { $0.key == "job-j1" }?.ownerUserId)
        XCTAssertEqual(rows.first { $0.key == "agent-pa1" }?.ownerName, "Jane")
    }
}
