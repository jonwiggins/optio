import SwiftUI
import UIKit

// Brand marks for the things work comes from and links to — GitHub, GitLab,
// Slack, Linear, Jira, Notion, Sentry, PagerDuty, Pylon, Datadog, Alertmanager,
// AWS — the agent runtimes that do it — Claude Code, OpenAI Codex, GitHub
// Copilot, Google Gemini, Cursor, OpenCode — plus GitHub's pull-request and
// issue glyphs. The iOS twin of the web's `components/brand-icon.tsx`.
//
// Vector imagesets live in `Shared/Brands.xcassets` (SVG, preserved vector
// data): brand marks from Simple Icons (CC0) — except AWS and Pylon, which
// have none and are drawn in `brand-icon.tsx`, and Alertmanager, which borrows
// Prometheus's torch — PR / issue glyphs from GitHub Primer Octicons (MIT).
// Every brand mark is a single-colour template image,
// so it takes `foregroundStyle` like an SF Symbol and reads in the surrounding
// text colour — no brand colours (Slack's four, Claude's orange). Only PR /
// issue glyphs carry a colour, and that is state, not brand. Marks are
// decorative unless given an accessibility label — keep a text label beside
// them or pass `label:`.

enum Brand: String, CaseIterable, Hashable, Sendable {
    case github, gitlab, slack, linear, jira, notion, sentry
    // Event sources and connection providers (the catalog's `icon` keys).
    case pagerduty, pylon, datadog, alertmanager, aws
    // Agent runtimes (`AgentMark`). OpenClaw has no Simple Icons mark, so it keeps a symbol.
    case claude, openai, copilot, gemini, cursor, opencode

    var label: String {
        switch self {
        case .github: return "GitHub"
        case .gitlab: return "GitLab"
        case .slack: return "Slack"
        case .linear: return "Linear"
        case .jira: return "Jira"
        case .notion: return "Notion"
        case .sentry: return "Sentry"
        case .pagerduty: return "PagerDuty"
        case .pylon: return "Pylon"
        case .datadog: return "Datadog"
        case .alertmanager: return "Alertmanager"
        case .aws: return "AWS"
        case .claude: return "Claude"
        case .openai: return "OpenAI"
        case .copilot: return "GitHub Copilot"
        case .gemini: return "Google Gemini"
        case .cursor: return "Cursor"
        case .opencode: return "OpenCode"
        }
    }

    /// A provider / source string ("github", "GitLab", "linear", …) → its brand, if we have one.
    init?(provider: String?) {
        guard let p = provider?.lowercased(), let b = Brand(rawValue: p) else { return nil }
        self = b
    }

    /// An agent type ("claude-code", "codex", "copilot", …) → its runtime's brand, if it has a mark.
    init?(agentType: String?) {
        switch agentType?.lowercased() {
        case "claude-code", "claude": self = .claude
        case "codex", "openai": self = .openai
        case "copilot": self = .copilot
        case "gemini": self = .gemini
        case "cursor": self = .cursor
        case "opencode": self = .opencode
        default: return nil
        }
    }

    /// The host a URL lives on → its brand (github.com, gitlab.*, linear.app, *.atlassian.net, …).
    init?(url: String?) {
        guard let host = url.flatMap({ URL(string: $0)?.host?.lowercased() }) else { return nil }
        if host.hasSuffix("github.com") { self = .github }
        else if host.contains("gitlab") { self = .gitlab }
        else if host.hasSuffix("linear.app") { self = .linear }
        else if host.hasSuffix("atlassian.net") || host.contains("jira") { self = .jira }
        else if host.hasSuffix("notion.so") || host.hasSuffix("notion.site") { self = .notion }
        else if host.hasSuffix("slack.com") { self = .slack }
        else if host.hasSuffix("sentry.io") { self = .sentry }
        else if host.hasSuffix("pagerduty.com") { self = .pagerduty }
        else if host.hasSuffix("usepylon.com") { self = .pylon }
        else if host.hasSuffix("datadoghq.com") || host.hasSuffix("datadoghq.eu") { self = .datadog }
        else if host.contains("grafana") || host.contains("alertmanager") { self = .alertmanager }
        else if host.hasSuffix("amazonaws.com") || host.hasSuffix("aws.amazon.com") { self = .aws }
        else { return nil }
    }

    var assetName: String { "brand.\(rawValue)" }
}

/// Pull-request state as the glyph shows it (GitHub's colours).
enum PRGlyphState: String, Hashable, Sendable {
    case open, merged, closed, draft

    /// Normalize the PR state strings the API returns. Unknown → open.
    init(_ state: String?) {
        switch (state ?? "").lowercased() {
        case "merged": self = .merged
        case "closed", "declined": self = .closed
        case "draft": self = .draft
        default: self = .open
        }
    }

    /// Green open, purple merged, red closed, grey draft.
    var color: Color {
        switch self {
        case .open: return StatusColor.green
        case .merged: return Color(red: 0x89 / 255, green: 0x57 / 255, blue: 0xE5 / 255)
        case .closed: return StatusColor.red
        case .draft: return Color.secondary
        }
    }

    var label: String {
        switch self {
        case .open: return "Open pull request"
        case .merged: return "Merged pull request"
        case .closed: return "Closed pull request"
        case .draft: return "Draft pull request"
        }
    }
}

/// One small mark: a brand, a PR / issue glyph, or a plain SF Symbol fallback.
enum Glyph: Hashable, Sendable {
    case brand(Brand)
    case pr(PRGlyphState)
    case issue(open: Bool)
    case symbol(String)

    /// For menus and `Label`s, where only an `Image` fits (a `UIMenu` item
    /// renders the template image tinted like a symbol).
    func image() -> Image {
        switch self {
        case .brand(let b): return Image(b.assetName, bundle: BrandAssets.bundle)
        case .pr(let s): return Image("pr.\(s.rawValue)", bundle: BrandAssets.bundle)
        case .issue(let open): return Image(open ? "issue.open" : "issue.closed", bundle: BrandAssets.bundle)
        case .symbol(let name): return Image(systemName: name)
        }
    }

    /// GitHub's state colour for PR / issue glyphs; nil means "inherit".
    var tint: Color? {
        switch self {
        case .pr(let s): return s.color
        case .issue(let open): return open ? StatusColor.green : Color(red: 0x89 / 255, green: 0x57 / 255, blue: 0xE5 / 255)
        default: return nil
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .brand(let b): return b.label
        case .pr(let s): return s.label
        case .issue(let open): return open ? "Open issue" : "Closed issue"
        case .symbol: return ""
        }
    }

    /// A trigger type → its mark: the event / ticket triggers show the brand
    /// they listen to, the rest keep their SF Symbols.
    static func trigger(_ type: String, source: String? = nil) -> Glyph {
        switch type {
        case "github": return .brand(.github)
        case "gitlab": return .brand(.gitlab)
        case "slack": return .brand(.slack)
        case "linear": return .brand(.linear)
        case "jira": return .brand(.jira)
        case "sentry": return .brand(.sentry)
        case "pagerduty": return .brand(.pagerduty)
        case "pylon": return .brand(.pylon)
        case "alertmanager": return .brand(.alertmanager)
        case "datadog": return .brand(.datadog)
        case "ticket": return Brand(provider: source).map(Glyph.brand) ?? .symbol("ticket")
        case "manual": return .symbol("hand.tap")
        case "schedule": return .symbol("clock")
        case "webhook": return .symbol("antenna.radiowaves.left.and.right")
        default: return .symbol("bolt")
        }
    }

    /// An agent type → its runtime's mark; "terminal" shows a terminal, and a
    /// runtime with no mark (OpenClaw, anything unknown) keeps `fallback`.
    static func agent(_ runtime: String?, fallback: String = "bolt") -> Glyph {
        if runtime == "terminal" { return .symbol("terminal") }
        return Brand(agentType: runtime).map(Glyph.brand) ?? .symbol(fallback)
    }

    /// A connection provider's `icon` key → its mark: the brand's logo when it
    /// has one (notion, github, slack, linear, sentry, aws, pylon, pagerduty),
    /// a generic symbol for the generic keys (database, folder, terminal,
    /// globe), else a plug — the web's `connection-mark.tsx`.
    static func provider(icon: String?) -> Glyph {
        if let brand = Brand(provider: icon) { return .brand(brand) }
        switch (icon ?? "").lowercased() {
        case "database": return .symbol("cylinder")
        case "folder": return .symbol("folder")
        case "terminal": return .symbol("terminal")
        case "globe": return .symbol("globe")
        default: return .symbol("powerplug")
        }
    }
}

/// A glyph sized like an SF Symbol at `size` points (scales with Dynamic Type).
/// Template marks follow `foregroundStyle`; PR / issue glyphs use their state
/// colour unless `tinted: false`.
struct GlyphView: View {
    let glyph: Glyph
    var size: CGFloat = 13
    var tinted = true
    /// Accessibility name; without it the mark is decorative.
    var label: String? = nil
    @ScaledMetric(relativeTo: .caption) private var scale: CGFloat = 1

    var body: some View {
        mark
            .accessibilityHidden(label == nil)
            .accessibilityLabel(label ?? "")
    }

    @ViewBuilder private var mark: some View {
        switch glyph {
        case .symbol(let name):
            Image(systemName: name).font(.system(size: size * scale * 0.9))
        default:
            let image = glyph.image().resizable().scaledToFit().frame(width: size * scale, height: size * scale)
            if tinted, let tint = glyph.tint { image.foregroundStyle(tint) } else { image }
        }
    }
}

/// `BrandMark(.github)` — a brand mark sized like a symbol.
struct BrandMark: View {
    let brand: Brand
    var size: CGFloat = 13
    var label: String? = nil

    init(_ brand: Brand, size: CGFloat = 13, label: String? = nil) {
        self.brand = brand
        self.size = size
        self.label = label
    }

    var body: some View { GlyphView(glyph: .brand(brand), size: size, label: label) }
}

/// `AgentMark(runtime: "codex")` — the agent runtime's logo, sized like a symbol.
/// Decorative unless given `label:` (keep the runtime's name beside it).
struct AgentMark: View {
    let runtime: String?
    var size: CGFloat = 13
    var fallback = "bolt"
    var label: String? = nil

    var body: some View { GlyphView(glyph: .agent(runtime, fallback: fallback), size: size, label: label) }
}

/// `TriggerIcon(type:)` — github / gitlab / slack / linear / jira / sentry /
/// pagerduty / pylon / alertmanager / datadog / ticket → brand; manual /
/// schedule / webhook and the rest keep SF Symbols.
struct TriggerIcon: View {
    let type: String
    var source: String? = nil
    var size: CGFloat = 13

    var body: some View { GlyphView(glyph: .trigger(type, source: source), size: size) }

    /// "GitHub", "Slack", "PagerDuty", "Alertmanager", "Schedule", … for a trigger type.
    static func label(_ type: String) -> String {
        Brand(provider: type)?.label ?? type.capitalized
    }
}

/// Resolves vector marks in the app, widget extension, and snapshot test bundle.
private final class BrandAssets: NSObject {
    static let bundle = Bundle(for: BrandAssets.self)
}
