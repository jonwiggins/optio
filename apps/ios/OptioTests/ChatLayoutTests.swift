import SwiftUI
import XCTest
@testable import Optio

/// Reviewable captures of the production chat, including a narrow phone with
/// larger text. No server, agent execution, or personal conversation required.
@MainActor
final class ChatLayoutTests: XCTestCase {
    func testLocalSendBeforeTranscriptCatchesUp() async throws {
        let model = LocalTranscriptModel(api: APIClient(), terminalId: "preview")
        let started = expectation(description: "input in flight")
        var continuation: CheckedContinuation<Void, Error>?
        let send = Task {
            await model.send("Please check the build and explain what failed.") { _ in
                try await withCheckedThrowingContinuation { continuation = $0; started.fulfill() }
            }
        }
        await fulfillment(of: [started], timeout: 2)
        let view = LocalTranscriptFace(terminalId: "preview", entries: [], transcript: model,
                                       live: true, canSend: true, working: false,
                                       activity: LocalChatActivity(title: "Waiting for the agent to pick up your message", symbol: "clock"),
                                       onSend: { _ in })
        try await capture(view, name: "local-sending", dark: false)
        continuation?.resume(throwing: URLError(.networkConnectionLost))
        await send.value
        try await capture(view, name: "local-unconfirmed", dark: true, width: 320)
    }

    func testWorkChatLayouts() async throws {
        let model = SessionChatModel(sessionId: "preview", api: APIClient())
        model.handle(.json(["type": "history_done", "count": 0]))
        model.handle(.json(["type": "status", "status": "ready"]))
        let frame = try XCTUnwrap(model.prepareSend("Can you check why the build is failing?\nPlease keep the fix small."))
        try await capture(SessionChatView(chat: model, modelConfig: nil), name: "sending", dark: false)
        model.handle(.json(["type": "user_message", "requestId": frame["requestId"]!, "content": frame["content"]!]))
        model.handle(.json(["type": "status", "status": "executing"]))
        for (type, text) in [("text", "I’m checking the build output and the failing test."),
                             ("tool_use", "pnpm test"), ("tool_result", "One assertion needs updating.")] {
            model.handle(.json(["type": "chat_event", "event": ["taskId": "preview", "timestamp": "", "type": type, "content": text]]))
        }
        try await capture(SessionChatView(chat: model, modelConfig: nil), name: "working-dark", dark: true)
        model.handle(.json(["type": "chat_event", "event": ["taskId": "preview", "timestamp": "", "type": "text", "content": "The build is passing again. I updated the assertion to match the new response format.\n\nAll 12 tests pass."]]))
        model.handle(.json(["type": "status", "status": "idle"]))
        try await capture(SessionChatView(chat: model, modelConfig: nil).environment(\.dynamicTypeSize, .xxxLarge),
                          name: "finished-large-text", dark: false, width: 320)
    }

    private func capture<V: View>(_ view: V, name: String, dark: Bool, width: CGFloat = 393) async throws {
        let host = UIHostingController(rootView: view.environment(\.colorScheme, dark ? .dark : .light)
            .background(dark ? Color.black : Color.white))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: 740)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; previousKeyWindow?.makeKey() }
        host.view.frame = window.bounds
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(350))
        let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
            XCTAssertTrue(host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true), "Chat must be attached and rendered")
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("optio-chat-previews")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(name + ".png")
        try XCTUnwrap(image.pngData()).write(to: file)
        NSLog("chat preview → %@", file.path)
    }
}
