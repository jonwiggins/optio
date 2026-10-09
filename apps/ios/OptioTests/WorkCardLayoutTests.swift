import XCTest
import SwiftUI
@testable import Optio

@MainActor
final class WorkCardLayoutTests: XCTestCase {
    func testManyLinksStayCompactUntilExpanded() throws {
        let links = (1...32).map { WorkLink(url: "https://github.com/acme/app/pull/\($0)", kind: .pr, provider: .github, label: "#\($0)") }
        let collapsed = ImageRenderer(content: SessionLinkBadges(links: links).padding().frame(width: 390))
        let expanded = ImageRenderer(content: SessionLinkBadges(links: links, expanded: true).padding().frame(width: 390))
        let short = try XCTUnwrap(collapsed.uiImage)
        let tall = try XCTUnwrap(expanded.uiImage)
        XCTAssertLessThan(short.size.height, 160, "32 links must not stretch a resting card")
        XCTAssertGreaterThan(tall.size.height, short.size.height * 2)
    }

    func testSessionHeaderAtPhoneWidth() throws {
        let links = (1...32).map { WorkLink(url: "https://github.com/acme/app/pull/\($0)", kind: .pr, provider: .github, label: "#\($0)") }
        let content = SessionIdentityHeader(title: "Improve the session cards", runtime: "codex", status: "Waiting for you", tone: .accent,
                                            location: "/Users/jon/repos/optio", links: links) {
            SessionViewToggle(view: .transcript) { _ in }
        }.frame(width: 390).environment(\.colorScheme, .light)
        let image = try XCTUnwrap(ImageRenderer(content: content).uiImage)
        XCTAssertLessThan(image.size.height, 340, "Leave room for the conversation with many linked PRs")
        let attachment = XCTAttachment(image: image)
        attachment.name = "session-header"
        attachment.lifetime = .keepAlways
        add(attachment)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("session-header.png")
        try image.pngData()?.write(to: url)
        print("SESSION_HEADER_PREVIEW \(url.path)")
    }

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
