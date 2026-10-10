import XCTest
import SwiftUI
import UIKit
@testable import Optio

@MainActor
final class WorkCardLayoutTests: XCTestCase {
    func testManyLinksStayCompactUntilExpanded() throws {
        let links = (1...300).map { WorkLink(url: "https://github.com/acme/app/pull/\($0)", kind: .pr, provider: .github, label: "#\($0)") }
        XCTAssertEqual(SessionLinkBadges(links: links).visibleLinks.count, 2)
        XCTAssertEqual(SessionLinkBadges(links: links, expanded: true).visibleLinks.map(\.label), (1...8).map { "#\($0)" })
        let collapsed = ImageRenderer(content: SessionLinkBadges(links: links).padding().frame(width: 390))
        let expanded = ImageRenderer(content: SessionLinkBadges(links: links, expanded: true).padding().frame(width: 390))
        let short = try XCTUnwrap(collapsed.uiImage)
        let tall = try XCTUnwrap(expanded.uiImage)
        XCTAssertLessThan(short.size.height, 160, "Hundreds of links must not stretch a resting card")
        XCTAssertGreaterThan(tall.size.height, short.size.height)
        XCTAssertLessThan(tall.size.height, 320, "Expanded cards still stop at eight badges")
    }

    func testSessionHeaderAtPhoneWidth() throws {
        let links = (1...32).map { WorkLink(url: "https://github.com/acme/app/pull/\($0)", kind: .pr, provider: .github, label: "#\($0)") }
        let content = SessionIdentityHeader(title: "Improve the session cards", runtime: "codex", status: "Waiting for you", tone: .accent,
                                            location: "/Users/jon/repos/optio", links: links) {
            SessionViewToggle(view: .transcript) { _ in }
        }.frame(width: 390).environment(\.colorScheme, .light)
        // UIKit-backed segmented controls need a hosting view, not ImageRenderer.
        let host = UIHostingController(rootView: content)
        host.safeAreaRegions = []
        let size = host.sizeThatFits(in: CGSize(width: 390, height: 1000))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; previous?.makeKey() }
        host.view.frame = window.bounds
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        let image = UIGraphicsImageRenderer(size: size).image { _ in
            host.view.drawHierarchy(in: CGRect(origin: .zero, size: size), afterScreenUpdates: true)
        }
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
