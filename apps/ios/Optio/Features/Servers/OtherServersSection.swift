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
                    Text("\(glance.needsYou) need\(glance.needsYou == 1 ? "s" : "") you").foregroundStyle(Tone.accent.textStyle).fontWeight(.medium)
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

/// Card at the top of the Overview naming the active server. Laid out like a
/// Settings row: a coloured icon tile carries the server colour, then title,
/// subtitle and a chevron into Manage servers.
struct ActiveServerCard: View {
    @Environment(SessionStore.self) private var session
    var hostsOnline: Int? = nil
    var hostsTotal: Int? = nil
    @State private var showServers = false

    var body: some View {
        if let server = session.activeServer {
            Button { showServers = true } label: {
                HStack(spacing: Spacing.m) {
                    ServerIconTile(color: server.color)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(server.name).font(.body.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                        Text(server.host).font(.monoFootnote).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        if let detail { detail.font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                    }
                    Spacer(minLength: Spacing.s)
                    if session.hasMultipleServers {
                        Text("1 of \(session.servers.count)").font(.footnote).foregroundStyle(.tertiary)
                    }
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .padding(.vertical, Spacing.m)
                .padding(.horizontal, Spacing.l)
                .contentShape(Radius.cardShape)
            }
            .buttonStyle(.plain)
            .background(Surface.card, in: Radius.cardShape)
            .accessibilityElement(children: .combine)
            .accessibilityHint("Opens Manage servers")
            .sheet(isPresented: $showServers) { NavigationStack { ServersView(inSheet: true) } }
        }
    }

    private var detail: Text? {
        var parts: [Text?] = []
        if let u = session.user?.displayName ?? session.user?.email {
            parts.append(Text(u))
        } else if session.switching {
            parts.append(Text("Connecting…"))
        }
        if let total = hostsTotal, total > 0, let online = hostsOnline {
            parts.append(Text(online == 0 ? "local host offline" : "\(online)/\(total) local host\(total == 1 ? "" : "s") online"))
        }
        return Text.meta(parts)
    }
}

/// The Settings-style icon tile: a continuous rounded square in the server
/// colour with a white laptop symbol.
struct ServerIconTile: View {
    let color: ServerColor
    var size: CGFloat = 36

    var body: some View {
        Image(systemName: "laptopcomputer")
            .font(.system(size: size * 0.5, weight: .medium))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(color.swiftUI, in: RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
            .accessibilityHidden(true)
    }
}
