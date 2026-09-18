import Foundation

/// The data every glanceable surface (widgets, Watch activity, intents) reads:
/// what needs you, what's running, and when it was computed. Built from the same
/// endpoints the app's Local hub uses so phone and web agree.
public struct NeedsYouSnapshot: Codable, Hashable, Sendable {
    public var needsYou: [WatchItem]
    public var running: [WatchItem]
    public var hostsOnline: Int
    public var hostsTotal: Int
    public var asOf: Date

    public init(needsYou: [WatchItem], running: [WatchItem], hostsOnline: Int, hostsTotal: Int, asOf: Date = .now) {
        self.needsYou = needsYou
        self.running = running
        self.hostsOnline = hostsOnline
        self.hostsTotal = hostsTotal
        self.asOf = asOf
    }

    public static let empty = NeedsYouSnapshot(needsYou: [], running: [], hostsOnline: 0, hostsTotal: 0)

    /// Derives the Watch content state per the product brief: oldest needs-you item
    /// first, up to two more listed, counts for the rest.
    public func watchState() -> WatchState {
        if hostsTotal > 0, hostsOnline == 0 {
            return WatchState(phase: .offline, head: needsYou.first, needsYouCount: needsYou.count, runningCount: running.count, offlineSince: asOf, asOf: asOf)
        }
        let sorted = needsYou.sorted { $0.since < $1.since }
        if let head = sorted.first {
            return WatchState(phase: .waiting, head: head, others: Array(sorted.dropFirst().prefix(2)), needsYouCount: sorted.count, runningCount: running.count, asOf: asOf)
        }
        let latest = running.sorted { $0.since > $1.since }.first
        return WatchState(phase: .working, head: latest, needsYouCount: 0, runningCount: running.count, asOf: asOf)
    }

    // MARK: - Loading from the API (local terminals; tasks/agents join in Tier 2)

    private struct HostRow: Decodable { let id: String; let state: String }
    private struct TerminalRow: Decodable {
        let id: String; let title: String; let dir: String; let state: String
        let attentionState: String?; let attentionReason: String?; let preview: String?
        let attentionChangedAt: Date?; let startedAt: Date?; let updatedAt: Date?
        let spec: Spec?
        struct Spec: Decodable { let kind: String }
    }
    private struct HostsEnvelope: Decodable { let hosts: [HostRow] }
    private struct TerminalsEnvelope: Decodable { let terminals: [TerminalRow] }

    public static func load(using fetch: SharedFetch) async throws -> NeedsYouSnapshot {
        async let hostsTask = fetch.get("/api/local/hosts", as: HostsEnvelope.self)
        async let termsTask = fetch.get("/api/local/terminals", query: ["state": "running"], as: TerminalsEnvelope.self)
        let (hosts, terms) = try await (hostsTask, termsTask)
        var needs: [WatchItem] = []
        var running: [WatchItem] = []
        for t in terms.terminals where t.state == "running" && t.spec?.kind == "agent" {
            let since = t.attentionChangedAt ?? t.updatedAt ?? t.startedAt ?? .now
            let item = WatchItem(
                kind: .local, id: t.id, title: t.title, mono: (t.dir as NSString).lastPathComponent,
                reason: t.attentionReason.map(Self.reasonText), preview: t.preview?.split(whereSeparator: \.isNewline).last.map(String.init),
                since: since, state: t.attentionState ?? t.state, link: DeepLink.local(t.id, compose: true).url.absoluteString)
            if t.attentionState == "needs_you" { needs.append(item) } else { running.append(item) }
        }
        return NeedsYouSnapshot(needsYou: needs, running: running, hostsOnline: hosts.hosts.filter { $0.state == "online" }.count, hostsTotal: hosts.hosts.count)
    }

    static func reasonText(_ raw: String) -> String {
        switch raw {
        case "notification": return "Waiting on a permission"
        case "stop": return "Claude stopped — reply to continue"
        case "quiet", "silence": return "Gone quiet"
        default: return raw.replacingOccurrences(of: "_", with: " ")
        }
    }
}
