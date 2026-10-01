import XCTest
import UIKit
@testable import Optio

/// The brand / trigger glyph mapping, and that every mark's imageset ships.
final class BrandMarkTests: XCTestCase {
    func testEveryAssetLoads() {
        for b in Brand.allCases {
            XCTAssertNotNil(UIImage(named: b.assetName()), b.rawValue)
            XCTAssertNotNil(UIImage(named: b.assetName(mono: true)), b.rawValue)
        }
        for name in ["pr.open", "pr.merged", "pr.closed", "pr.draft", "issue.open", "issue.closed"] {
            XCTAssertNotNil(UIImage(named: name), name)
        }
    }

    func testTriggerGlyphs() {
        XCTAssertEqual(Glyph.trigger("github"), .brand(.github))
        XCTAssertEqual(Glyph.trigger("slack"), .brand(.slack))
        XCTAssertEqual(Glyph.trigger("linear"), .brand(.linear))
        XCTAssertEqual(Glyph.trigger("ticket", source: "jira"), .brand(.jira))
        XCTAssertEqual(Glyph.trigger("ticket"), .symbol("ticket"))
        XCTAssertEqual(Glyph.trigger("schedule"), .symbol("clock"))
        XCTAssertEqual(Glyph.trigger("manual"), .symbol("hand.tap"))
        XCTAssertEqual(TriggerIcon.label("github"), "GitHub")
        XCTAssertEqual(TriggerIcon.label("webhook"), "Webhook")
    }

    func testAgentGlyphs() {
        XCTAssertEqual(Glyph.agent("claude-code"), .brand(.claude))
        XCTAssertEqual(Glyph.agent("codex"), .brand(.openai))
        XCTAssertEqual(Glyph.agent("copilot"), .brand(.copilot))
        XCTAssertEqual(Glyph.agent("gemini"), .brand(.gemini))
        XCTAssertEqual(Glyph.agent("cursor"), .brand(.cursor))
        XCTAssertEqual(Glyph.agent("opencode"), .brand(.opencode))
        XCTAssertEqual(Glyph.agent("openclaw"), .symbol("bolt"))
        XCTAssertEqual(Glyph.agent("openclaw", fallback: "cpu"), .symbol("cpu"))
        XCTAssertEqual(Glyph.agent("terminal"), .symbol("terminal"))
        XCTAssertEqual(Glyph.agent(nil), .symbol("bolt"))
        XCTAssertEqual(Brand.copilot.label, "GitHub Copilot")
    }

    func testBrandFromURLAndPRState() {
        XCTAssertEqual(Brand(url: "https://github.com/a/b/pull/1"), .github)
        XCTAssertEqual(Brand(url: "https://gitlab.example.com/g/p/-/merge_requests/2"), .gitlab)
        XCTAssertEqual(Brand(url: "https://linear.app/acme/issue/ENG-1"), .linear)
        XCTAssertNil(Brand(url: "https://example.com"))
        XCTAssertEqual(PRGlyphState("MERGED"), .merged)
        XCTAssertEqual(PRGlyphState(nil), .open)
    }

    func testWorkFeedCarriesTicketOrigin() {
        let rows = WorkFeed.collect(WorkFeed.Sources(unified: [
            WorkFeed.UnifiedRow(type: "repo-task", id: "t1", title: "Fix", state: "pr_opened",
                                prUrl: "https://github.com/a/b/pull/3", prState: "open", ticketSource: "linear"),
        ]))
        XCTAssertEqual(rows.first?.origin, .linear)
        XCTAssertEqual(rows.first?.when, "from a ticket")
        XCTAssertEqual(rows.first?.whenGlyph, .brand(.linear))
    }
}
