import XCTest
@testable import Optio

@MainActor
final class OptioAssistantWorkspaceTests: XCTestCase {
    private func session(_ title: String) -> OptioAssistantWorkspace.Session {
        .init(id: UUID().uuidString, title: title, createdAt: Date())
    }

    func testSwitchingKeepsIndependentDraftsStreamsAndApproval() throws {
        let workspace = OptioAssistantWorkspace()
        let first = session("First"), second = session("Second")
        workspace.reconcile([first, second])
        let a = try XCTUnwrap(workspace.models[first.id]), b = try XCTUnwrap(workspace.models[second.id])
        a.handle(.json(["type": "history", "frames": []]))
        b.handle(.json(["type": "history", "frames": []]))
        a.draft = "Unsent first draft"
        b.draft = "Unsent second draft"
        a.handle(.json(["type": "text", "content": "First reply"]))
        workspace.selectedID = second.id
        a.handle(.json(["type": "text", "content": " continues in background"]))
        b.handle(.json(["type": "action_proposal", "actionId": "approval", "description": "Review this", "items": [], "work": []]))
        XCTAssertEqual(a.rows.map(\.text), ["First reply continues in background"])
        XCTAssertEqual(a.draft, "Unsent first draft")
        XCTAssertEqual(b.draft, "Unsent second draft")
        XCTAssertTrue(b.needsApproval)
        XCTAssertFalse(a.needsApproval)
        workspace.selectedID = first.id
        XCTAssertTrue(workspace.selectedModel === a)
        XCTAssertTrue(workspace.isUnread(first.id))
        workspace.markRead(first.id)
        XCTAssertFalse(workspace.isUnread(first.id))
        XCTAssertEqual(workspace.attentionCount, 1)
    }

    func testReconciliationPreservesModelsAndMovesSelectionWhenEndedElsewhere() throws {
        let workspace = OptioAssistantWorkspace()
        let first = session("First"), second = session("Second")
        workspace.reconcile([first, second])
        let a = try XCTUnwrap(workspace.models[first.id])
        let b = try XCTUnwrap(workspace.models[second.id])
        b.draft = "Keep this"
        var renamed = second
        renamed.title = "Renamed on the web"
        workspace.reconcile([renamed])
        XCTAssertEqual(workspace.selectedID, second.id)
        XCTAssertTrue(workspace.selectedModel === b)
        XCTAssertEqual(b.draft, "Keep this")
        XCTAssertEqual(workspace.selected?.title, renamed.title)
        XCTAssertEqual(a.status, .disconnected)
        XCTAssertNil(workspace.models[first.id])
        workspace.reconcile([])
        XCTAssertNil(workspace.selectedID)
        XCTAssertTrue(workspace.models.isEmpty)
    }

    func testReconnectRestoresUnreadStateWithoutReportingAlreadyReadHistory() throws {
        let workspace = OptioAssistantWorkspace(), item = session("New session")
        workspace.reconcile([item])
        let model = try XCTUnwrap(workspace.selectedModel)
        let frames: [[String: Any]] = [["type": "user_message", "content": "Investigate CI"], ["type": "text", "content": "Found it"]]
        model.handle(.json(["type": "history", "frames": frames]))
        workspace.markRead(item.id)
        model.stop()
        model.handle(.json(["type": "history", "frames": frames]))
        XCTAssertFalse(workspace.isUnread(item.id))
        XCTAssertEqual(workspace.title(for: item), "Investigate CI")
        model.handle(.json(["type": "text", "content": ". Here is the fix."]))
        XCTAssertTrue(workspace.isUnread(item.id))
    }

    func testSocketTargetsExactSessionAndKeepsTokenOutOfURL() {
        let api = APIClient()
        api.configure(baseURL: URL(string: "https://optio.example"), token: "secret", workspaceId: "workspace")
        let id = UUID().uuidString
        let model = OptioAssistantModel(conversationID: id)
        XCTAssertEqual(model.socketURL(api: api).absoluteString, "wss://optio.example/ws/optio/chat?sessionId=\(id)")
        XCTAssertEqual(OptioAssistantModel().socketURL(api: api).absoluteString, "wss://optio.example/ws/optio/chat")
    }

    func testEndingBusyOrUnconfirmedSessionNeverCallsAPI() async throws {
        let workspace = OptioAssistantWorkspace(), item = session("Busy")
        workspace.reconcile([item])
        let model = try XCTUnwrap(workspace.selectedModel)
        model.handle(.json(["type": "history", "frames": []]))
        let api = APIClient() // Deliberately unconfigured: a network request would fail.
        for status in ["thinking", "executing", "waiting_for_approval", "disconnected"] {
            model.handle(.json(["type": "status", "status": status]))
            let ended = await workspace.end(item.id, api: api)
            XCTAssertFalse(ended)
        }
        model.handle(.json(["type": "status", "status": "ready"]))
        model.handle(.json(["type": "queue", "messages": [["requestId": "queued", "content": "Later"]]]))
        let ended = await workspace.end(item.id, api: api)
        XCTAssertFalse(ended)
        XCTAssertEqual(workspace.sessions.count, 1)
    }
    func testCRUDUsesScopedAPIAndFailedEndKeepsConversation() async throws {
        let item = session("Original")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AssistantAPIProtocol.self]
        let api = APIClient(session: URLSession(configuration: configuration))
        api.configure(baseURL: URL(string: "https://fixture.invalid"), token: "fixture-token", workspaceId: "workspace-a")
        let workspace = OptioAssistantWorkspace()
        var requests: [String] = []
        var rejectEnd = true
        AssistantAPIProtocol.respond = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-workspace-id"), "workspace-a")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-token")
            requests.append(request.httpMethod!)
            let value: [String: Any] = ["id": item.id, "title": request.httpMethod == "PATCH" ? "Renamed" : item.title, "createdAt": "2026-11-08T00:00:00Z"]
            switch request.httpMethod {
            case "GET": return (200, ["sessions": []])
            case "DELETE": return rejectEnd ? (503, ["error": "Temporarily unavailable"]) : (204, [:])
            default: return (200, ["session": value])
            }
        }
        defer { AssistantAPIProtocol.respond = nil }
        await workspace.refresh(api: api)
        XCTAssertTrue(workspace.sessions.isEmpty)
        let created = await workspace.create(api: api)
        XCTAssertTrue(created)
        let model = try XCTUnwrap(workspace.selectedModel)
        model.draft = "Do not lose this"
        let renamed = await workspace.rename(item.id, title: "Renamed", api: api)
        XCTAssertTrue(renamed)
        XCTAssertEqual(workspace.selected?.title, "Renamed")
        XCTAssertTrue(workspace.selectedModel === model)
        model.handle(.json(["type": "history", "frames": []]))
        model.handle(.json(["type": "status", "status": "ready"]))
        let failedEnd = await workspace.end(item.id, api: api)
        XCTAssertFalse(failedEnd)
        XCTAssertNotNil(workspace.error)
        XCTAssertEqual(workspace.selectedModel?.draft, "Do not lose this")
        rejectEnd = false
        let ended = await workspace.end(item.id, api: api)
        XCTAssertTrue(ended)
        XCTAssertNil(workspace.selectedModel)
        XCTAssertNil(workspace.error)
        XCTAssertEqual(requests, ["GET", "POST", "PATCH", "DELETE", "DELETE"])
    }

    func testSlowRefreshCannotUndoRenameOrDisableSessionControls() async throws {
        let item = session("Original")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AssistantAPIProtocol.self]
        let api = APIClient(session: URLSession(configuration: configuration))
        api.configure(baseURL: URL(string: "https://fixture.invalid"), token: "fixture", workspaceId: nil)
        let original: [String: Any] = ["id": item.id, "title": "Original", "createdAt": "2026-11-08T00:00:00Z"]
        var renamed = original
        renamed["title"] = "Renamed"
        AssistantAPIProtocol.respond = { request in
            request.httpMethod == "PATCH" ? (200, ["session": renamed]) : (200, ["sessions": [original]])
        }
        defer { AssistantAPIProtocol.respond = nil; AssistantAPIProtocol.intercept = nil }
        let workspace = OptioAssistantWorkspace()
        await workspace.refresh(api: api)
        let model = try XCTUnwrap(workspace.selectedModel)
        model.draft = "Keep the draft"
        let started = expectation(description: "refresh in flight")
        var pending: AssistantAPIProtocol?
        AssistantAPIProtocol.intercept = { loader in
            guard loader.request.httpMethod == "GET" else { return false }
            pending = loader
            started.fulfill()
            return true
        }
        let refresh = Task { await workspace.refresh(api: api) }
        defer { refresh.cancel() }
        await fulfillment(of: [started], timeout: 3)
        XCTAssertFalse(workspace.isLoading, "Background polling must not disable controls or dismiss a confirmation")
        let saved = await workspace.rename(item.id, title: "Renamed", api: api)
        XCTAssertTrue(saved)
        try XCTUnwrap(pending).complete(status: 200, body: ["sessions": [original]])
        await refresh.value
        XCTAssertEqual(workspace.selected?.title, "Renamed")
        XCTAssertTrue(workspace.selectedModel === model)
        XCTAssertEqual(model.draft, "Keep the draft")
    }

    func testOnlyMissingEndpointFallsBackToLegacyConversation() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AssistantAPIProtocol.self]
        let api = APIClient(session: URLSession(configuration: configuration))
        api.configure(baseURL: URL(string: "https://fixture.invalid"), token: "fixture", workspaceId: nil)
        defer { AssistantAPIProtocol.respond = nil }
        for code in [403, 500, 404] {
            let workspace = OptioAssistantWorkspace()
            AssistantAPIProtocol.respond = { _ in (code, ["error": "Unavailable"]) }
            await workspace.refresh(api: api)
            XCTAssertEqual(workspace.isLegacy, code == 404)
            XCTAssertEqual(workspace.sessions.count, code == 404 ? 1 : 0)
            XCTAssertEqual(workspace.error == nil, code == 404)
        }
    }

}


private final class AssistantAPIProtocol: URLProtocol, @unchecked Sendable {
    static var respond: ((URLRequest) -> (Int, [String: Any]))?
    static var intercept: ((AssistantAPIProtocol) -> Bool)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if Self.intercept?(self) == true { return }
        let (status, body) = Self.respond!(request)
        complete(status: status, body: body)
    }
    func complete(status: Int, body: [String: Any]) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
