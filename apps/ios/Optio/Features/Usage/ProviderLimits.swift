import Foundation

// Pure projection of "how far along am I on each agent subscription", a port of
// `collectProviderLimits` / `windowLabel` / `resetsIn` in
// `apps/web/src/components/dashboard/limits-panel.tsx` and the bucket helpers in
// `apps/web/src/components/local/usage-chips.tsx`. No SwiftUI here so it can be
// unit-tested directly.

/// One rate-limit window as the panel draws it.
struct LimitWindow: Hashable, Sendable {
    /// 0–100 (clamped by the view).
    var usedPercent: Double
    var resetsAt: String?
    var windowMinutes: Double?
}

/// One provider's column in the limits panel.
struct ProviderLimits: Hashable, Sendable, Identifiable {
    enum Key: String, Hashable, Sendable { case claude, codex }

    struct Window: Hashable, Sendable, Identifiable {
        var label: String
        var window: LimitWindow
        var id: String { label }
    }

    var key: Key
    var name: String
    /// Where the number comes from, for the footnote.
    var source: String
    /// nil = live; otherwise the instant the snapshot was taken.
    var observedAt: String?
    var planType: String?
    var windows: [Window]

    var id: Key { key }
}

enum UsageLimits {
    /// Label a window by its length: 300 → "5h", 10080 → "7d".
    static func windowLabel(_ minutes: Double?, fallback: String) -> String {
        guard let minutes, minutes > 0 else { return fallback }
        let m = Int(minutes)
        if m % 1440 == 0 { return "\(m / 1440)d" }
        if m % 60 == 0 { return "\(m / 60)h" }
        return "\(m)m"
    }

    /// The Claude buckets worth a header slot: 5h, 7d, then one "7d <Model>" per
    /// model-scoped weekly cap (`accountBuckets` in usage-chips.tsx).
    static func claudeBuckets(_ usage: ClaudeUsageData) -> [ProviderLimits.Window] {
        var out: [ProviderLimits.Window] = []
        if let w = usage.fiveHour, let v = w.utilization {
            out.append(.init(label: "5h", window: LimitWindow(usedPercent: v, resetsAt: w.resetsAt)))
        }
        if let w = usage.sevenDay, let v = w.utilization {
            out.append(.init(label: "7d", window: LimitWindow(usedPercent: v, resetsAt: w.resetsAt)))
        }
        for m in usage.sevenDayModels ?? [] {
            if let v = m.utilization {
                out.append(.init(label: "7d \(m.model)", window: LimitWindow(usedPercent: v, resetsAt: m.resetsAt)))
            }
        }
        return out
    }

    /// Fold Claude's live account usage and every host's Codex snapshot (the
    /// freshest wins) into a uniform list for the panel.
    static func collectProviderLimits(usage: ClaudeUsageData?, hosts: [LocalHost], now: Date = .now) -> [ProviderLimits] {
        var out: [ProviderLimits] = []
        if let usage, usage.available {
            let windows = claudeBuckets(usage)
            if !windows.isEmpty {
                out.append(ProviderLimits(key: .claude, name: "Claude", source: "account, live", observedAt: nil, planType: nil, windows: windows))
            }
        }

        var codex: LocalHostAgentLimits.Codex?
        for host in hosts {
            guard let c = host.agentLimits?.codex else { continue }
            // ISO-8601 strings from the same clock compare lexically, as the web does.
            if codex == nil || c.observedAt > codex!.observedAt { codex = c }
        }
        if let codex {
            var windows: [ProviderLimits.Window] = []
            func add(_ w: AgentLimitWindow?, fallback: String) {
                guard let w else { return }
                // A window that has since reset reads 0 — no point showing stale use.
                let reset = w.resetsAt?.isoDate.map { $0 < now } ?? false
                windows.append(.init(
                    label: windowLabel(w.windowMinutes, fallback: fallback),
                    window: LimitWindow(usedPercent: reset ? 0 : w.usedPercent, resetsAt: reset ? nil : w.resetsAt, windowMinutes: w.windowMinutes)
                ))
            }
            add(codex.primary, fallback: "5h")
            add(codex.secondary, fallback: "7d")
            if !windows.isEmpty {
                out.append(ProviderLimits(
                    key: .codex, name: "Codex", source: "from its session log on your machine",
                    observedAt: codex.observedAt, planType: codex.planType, windows: windows
                ))
            }
        }
        return out
    }

    /// "5h 12m", "3d 4h", "45m"; nil once the window has passed (or is unknown).
    static func resetsIn(_ resetsAt: String?, now: Date = .now) -> String? {
        guard let resetsAt, let date = resetsAt.isoDate else { return nil }
        let diff = date.timeIntervalSince(now)
        guard diff > 0 else { return nil }
        let h = Int(diff / 3600)
        let m = Int(diff.truncatingRemainder(dividingBy: 3600) / 60)
        if h >= 24 { return "\(h / 24)d \(h % 24)h" }
        return h > 0 ? "\(h)h \(m)m" : "\(m)m"
    }

    /// Whole percent in 0…100, the number every meter and pill prints.
    static func percent(_ value: Double?) -> Int {
        Int(min(max((value ?? 0).rounded(), 0), 100))
    }

    /// Coarse "how old are these numbers" for the stale note (`staleAge`).
    static func staleAge(_ asOf: String, now: Date = .now) -> String {
        guard let date = asOf.isoDate else { return asOf }
        let mins = max(0, Int((now.timeIntervalSince(date) / 60).rounded()))
        if mins < 1 { return "under a minute" }
        if mins < 60 { return "\(mins)m" }
        let h = mins / 60, m = mins % 60
        return m > 0 ? "\(h)h \(m)m" : "\(h)h"
    }
}

/// Meter / pill colour by how close a window is to its cap (the web's `tone`
/// and `pctTone`): green under 50, purple to 80, yellow to 95, red above.
enum UsageSeverity: Hashable, Sendable {
    case low, normal, warning, critical

    init(percent: Int) {
        if percent >= 95 { self = .critical } else if percent >= 80 { self = .warning } else if percent >= 50 { self = .normal } else { self = .low }
    }

    /// Whether the number should stand out from body text (pill text, meter percent).
    var isElevated: Bool { self == .warning || self == .critical }
}
