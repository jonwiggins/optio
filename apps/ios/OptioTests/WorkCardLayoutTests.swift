import XCTest
import SwiftUI
@testable import Optio

@MainActor
final class WorkCardLayoutTests: XCTestCase {
    func testCardsAtPhoneWidth() throws {
        let ticket = WorkLink(url: "https://linear.app/optio/issue/OPT-128", kind: .issue, provider: .linear, label: "OPT-128")
        let pr = WorkLink(url: "https://github.com/acme/optio/pull/42", kind: .pr, provider: .github, label: "acme/optio#42")
        for (name, scheme, size) in [("light", ColorScheme.light, DynamicTypeSize.large), ("dark", .dark, .large), ("large-text", .light, .accessibility3)] {
            let content = VStack(spacing: 12) {
                ForEach(["claude-code", "codex", "gemini"], id: \.self) { runtime in
                    WorkRowView(row: WorkRow(
                        key: runtime, source: .localTerminal, sourceId: runtime, href: "/local/demo",
                        name: "Improve the session cards", when: "now",
                        where: SessionWhere(target: .machine, detail: "MacBook · ~/optio", dir: "/Users/jon/repos/optio", hostName: "Jon’s MacBook"),
                        who: runtime, then: .waitsForMe, status: .needsYou, statusLabel: "needs you",
                        note: "Ready for your review", prUrl: pr.url, lastActivity: nil, recurring: false, spawned: false,
                        links: [ticket, pr]
                    ))
                    .padding(.horizontal, 16)
                    .background(Surface.card, in: Radius.cardShape)
                }
            }
            .padding(16)
            .frame(width: 390)
            .background(Surface.page)
            .environment(SessionStore())
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: content)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertEqual(image.size.width, 390)
            let attachment = XCTAttachment(image: image)
            attachment.name = "work-cards-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("work-cards-\(name).png")
            try image.pngData()?.write(to: url)
            print("WORK_CARD_PREVIEW \(url.path)")
        }
    }
}
