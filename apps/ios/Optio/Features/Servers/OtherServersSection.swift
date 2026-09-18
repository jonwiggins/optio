import Foundation
import Observation
import SwiftUI

/// Headline numbers for a server the app is *not* currently pointed at, fetched
/// directly with that server's own token. Enough to answer "is anything waiting
/// on me over there?" without switching.
struct ServerGlance: Hashable, Sendable {
    enum State: Hashable { case loading, online, unauthorized, unreachable }
    var server: ServerProfile
    var state: State = .loading
    var running = 0
    var needsYou = 0
    var failed = 0
    var hostsOnline = 0
    var hostsTotal = 0
    var asOf: Date?

    static func load(_ server: ServerProfile) async -> ServerGlance {
        var g = ServerGlance(server: server)
        guard let fetch = SharedFetch(server: server) else { g.state = .unauthorized; return g }
        struct StatsEnvelope: Decodable { let stats: DashTaskStats }
        async let stats = try? fetch.get("/api/tasks/stats", as: StatsEnvelope.self, timeout: 6)
        async let snapshot = try? NeedsYouSnapshot.load(using: fetch)
        let (s, snap) = await (stats, snapshot)
        guard s != nil || snap != nil else {
            // Distinguish a dead token from a dead network with one cheap call.
            do {
                _ = try await fetch.raw("GET", "/api/auth/me", query: [:], body: nil, timeout: 6)
                g.state = .online
            } catch let e as SharedFetch.Failure where e.status == 401 {
                g.state = .unauthorized
            } catch {
                g.state = .unreachable
            }
            return g
        }
        g.state = .online
        if let s = s?.stats {
            g.running = s.running
            g.needsYou = s.needsAttention
            g.failed = s.failed
        }
        if let snap {
            g.running += snap.running.count
            g.needsYou += snap.needsYou.count
            g.hostsOnline = snap.hostsOnline
            g.hostsTotal = snap.hostsTotal
        }
        g.asOf = .now
        return g
    }
}

@Observable
@MainActor
final class OtherServersModel {
    var glances: [ServerGlance] = []

    func refresh(servers: [ServerProfile]) async {
        // Keep stale numbers visible while reloading; add rows for new servers.
        var byId = Dictionary(uniqueKeysWithValues: glances.map { ($0.server.id, $0) })
        for s in servers where byId[s.id] == nil { byId[s.id] = ServerGlance(server: s) }
        glances = servers.compactMap { byId[$0.id] }
        await withTaskGroup(of: ServerGlance.self) { group in
            for s in servers { group.addTask { await ServerGlance.load(s) } }
            for await g in group {
                if let i = glances.firstIndex(where: { $0.server.id == g.server.id }) { glances[i] = g }
            }
        }
    }
}

/// Overview section listing every *other* paired server with its headline counts.
/// Tapping a row switches the app to that server.
struct OtherServersSection: View {
    @Environment(SessionStore.self) private var session
    @State private var model = OtherServersModel()

    private var others: [ServerProfile] { session.servers.filter { $0.id != session.activeServer?.id } }

    var body: some View {
        if !others.isEmpty {
            Section {
                ForEach(model.glances, id: \.server.id) { glance in
                    Button {
                        Task { await session.switchTo(glance.server.id) }
                    } label: {
                        OtherServerRow(glance: glance)
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                SectionHeader(title: "Other servers", detail: "\(others.count)").textCase(nil)
            } footer: {
                Text("Tap to switch. Counts are fetched straight from each server.")
            }
            .task(id: others.map(\.id)) {
                while !Task.isCancelled {
                    await model.refresh(servers: others)
                    try? await Task.sleep(for: .seconds(30))
                }
            }
        }
    }
}

struct OtherServerRow: View {
    let glance: ServerGlance

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.m) {
            ServerDot(color: glance.server.color, size: 10).padding(.top, 6)
            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack(spacing: 6) {
                    Text(glance.server.name).font(.body).foregroundStyle(.primary)
                    Text(glance.server.host).font(.monoCaption).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle)
                }
                meta
            }
            Spacer(minLength: Spacing.s)
            Image(systemName: "arrow.left.arrow.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .padding(.top, 4)
        }
        .padding(.vertical, Spacing.row)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var meta: some View {
        switch glance.state {
        case .loading:
            Text("Checking…").font(.subheadline).foregroundStyle(.tertiary)
        case .unreachable:
            Text("Unreachable").font(.subheadline).foregroundStyle(.secondary)
        case .unauthorized:
            Text("Token rejected — re-pair in Servers").font(.subheadline).foregroundStyle(.red)
        case .online:
            HStack(spacing: 6) {
                if glance.needsYou > 0 {
                    Text("\(glance.needsYou) need\(glance.needsYou == 1 ? "s" : "") you").foregroundStyle(AppTheme.accent).fontWeight(.medium)
                    Text("·").foregroundStyle(.tertiary)
                }
                Text("\(glance.running) running")
                if glance.failed > 0 {
                    Text("·").foregroundStyle(.tertiary)
                    Text("\(glance.failed) failed").foregroundStyle(.red)
                }
                if glance.hostsTotal > 0 {
                    Text("·").foregroundStyle(.tertiary)
                    Text(glance.hostsOnline == 0 ? "host offline" : "\(glance.hostsOnline)/\(glance.hostsTotal) host\(glance.hostsTotal == 1 ? "" : "s") online")
                }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
    }
}

/// Card at the top of the Overview naming the active server: colour, name, host,
/// who you are there. The one place the identity is spelled out in full.
struct ActiveServerCard: View {
    @Environment(SessionStore.self) private var session
    var hostsOnline: Int? = nil
    var hostsTotal: Int? = nil

    var body: some View {
        if let server = session.activeServer {
            HStack(spacing: Spacing.m) {
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(server.color.swiftUI)
                    .frame(width: 5)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(server.name).font(.headline)
                        if session.hasMultipleServers {
                            Text("· 1 of \(session.servers.count)").font(.footnote).foregroundStyle(.tertiary)
                        }
                    }
                    Text(server.host).font(.monoFootnote).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    HStack(spacing: 6) {
                        if let u = session.user?.displayName ?? session.user?.email {
                            Text(u)
                        } else if session.switching {
                            Text("Connecting…")
                        }
                        if let total = hostsTotal, total > 0, let online = hostsOnline {
                            Text("·").foregroundStyle(.tertiary)
                            Text(online == 0 ? "local host offline" : "\(online)/\(total) local host\(total == 1 ? "" : "s") online")
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, Spacing.s)
            .padding(.horizontal, Spacing.m)
            .background(Surface.card, in: RoundedRectangle(cornerRadius: Radius.card))
            .accessibilityElement(children: .combine)
        }
    }
}
