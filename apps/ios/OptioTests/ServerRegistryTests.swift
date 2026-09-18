import XCTest
@testable import Optio

final class ServerRegistryTests: XCTestCase {
    private var saved: [ServerProfile] = []
    private var savedActive: String?

    override func setUp() {
        super.setUp()
        saved = ServerRegistry.all
        savedActive = ServerRegistry.activeId
        ServerRegistry.all = []
        ServerRegistry.activeId = nil
    }

    override func tearDown() {
        for s in ServerRegistry.all { ServerRegistry.remove(s.id) }
        ServerRegistry.all = saved
        ServerRegistry.activeId = savedActive
        super.tearDown()
    }

    func testUpsertActivateRemove() {
        let a = ServerProfile(name: "Laptop", url: URL(string: "http://a.test:30400")!, color: .slate)
        let b = ServerProfile(name: "Studio", url: URL(string: "http://b.test:30400")!, color: .teal)
        ServerRegistry.upsert(a)
        ServerRegistry.upsert(b)
        ServerRegistry.activeId = b.id
        XCTAssertEqual(ServerRegistry.all.map(\.id), [a.id, b.id])
        XCTAssertEqual(ServerRegistry.active?.id, b.id)

        XCTAssertTrue(ServerRegistry.setToken("optio_pat_a", for: a.id))
        XCTAssertTrue(ServerRegistry.setToken("optio_pat_b", for: b.id))
        XCTAssertEqual(ServerRegistry.token(for: a.id), "optio_pat_a")
        // Active first, then by addedAt.
        XCTAssertEqual(ServerRegistry.configured.map(\.id), [b.id, a.id])

        // Rename keeps identity.
        var renamed = a
        renamed.name = "MacBook"
        ServerRegistry.upsert(renamed)
        XCTAssertEqual(ServerRegistry.profile(a.id)?.name, "MacBook")
        XCTAssertEqual(ServerRegistry.all.count, 2)

        // Removing the active server falls back to the remaining one and drops its token.
        ServerRegistry.remove(b.id)
        XCTAssertEqual(ServerRegistry.active?.id, a.id)
        XCTAssertNil(ServerRegistry.token(for: b.id))
        XCTAssertEqual(ServerRegistry.token(for: a.id), "optio_pat_a")
    }

    func testSharedCredentialsDescribeActiveServer() {
        let a = ServerProfile(name: "Laptop", url: URL(string: "http://a.test:30400")!, color: .slate, workspaceId: "ws-1")
        ServerRegistry.upsert(a)
        ServerRegistry.activeId = a.id
        ServerRegistry.setToken("optio_pat_a", for: a.id)
        XCTAssertEqual(SharedCredentials.serverURL, a.url)
        XCTAssertEqual(SharedCredentials.token, "optio_pat_a")
        XCTAssertEqual(SharedCredentials.workspaceId, "ws-1")
        XCTAssertTrue(SharedCredentials.isConfigured)
        SharedCredentials.workspaceId = nil
        XCTAssertNil(ServerRegistry.profile(a.id)?.workspaceId)
    }

    func testNextColorSkipsUsed() {
        XCTAssertEqual(ServerColor.next(avoiding: []), .slate)
        XCTAssertEqual(ServerColor.next(avoiding: [.slate]), .blue)
        XCTAssertEqual(ServerColor.next(avoiding: [.slate, .blue, .teal]), .green)
        XCTAssertEqual(ServerColor.next(avoiding: ServerColor.allCases), .slate)
    }

    func testSharedFetchResolvesServer() {
        let a = ServerProfile(name: "Laptop", url: URL(string: "http://a.test:30400")!, color: .slate)
        let b = ServerProfile(name: "Studio", url: URL(string: "http://b.test:30400")!, color: .teal)
        ServerRegistry.upsert(a); ServerRegistry.upsert(b)
        ServerRegistry.activeId = a.id
        ServerRegistry.setToken("ta", for: a.id)
        ServerRegistry.setToken("tb", for: b.id)
        XCTAssertEqual(SharedFetch.resolve(b.id)?.baseURL, b.url)
        XCTAssertEqual(SharedFetch.resolve(b.id)?.serverName, "Studio")
        XCTAssertEqual(SharedFetch.resolve(nil)?.baseURL, a.url)
        XCTAssertEqual(SharedFetch.resolve("missing")?.baseURL, a.url)
        XCTAssertEqual(SharedFetch.allServers.map(\.serverId), [a.id, b.id])
    }
}

final class DeepLinkServerTests: XCTestCase {
    func testServerHintRoundTrips() {
        let url = DeepLink.local("t1", compose: true).url(server: "srv-1")
        XCTAssertEqual(DeepLink.serverId(in: url), "srv-1")
        XCTAssertEqual(DeepLink(url: url), .local("t1", compose: true))
        XCTAssertNil(DeepLink.serverId(in: DeepLink.task("x").url))
        XCTAssertEqual(DeepLink.serverId(in: DeepLink.needsYou.url(server: "s")), "s")
        XCTAssertEqual(DeepLink(url: DeepLink.needsYou.url(server: "s")), .needsYou)
    }
}
