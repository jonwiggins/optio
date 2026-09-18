import SwiftUI
import Observation

@Observable
@MainActor
final class ConnectionsModel {
    var providers: [ConnectionProviderRow] = []
    var connections: [ConnectionRow] = []
    var mcpServers: [McpServerRow] = []
    var repos: [RepoRow] = []
    var loading = false
    var error: Error?

    func load(api: APIClient) async {
        loading = connections.isEmpty && providers.isEmpty
        defer { loading = false }
        async let p = api.listConnectionProviders()
        async let c = api.listConnections()
        async let m = api.listMcpServers(scope: "global")
        async let r = api.listRepos()
        do {
            connections = try await c
            error = nil
        } catch {
            self.error = error
        }
        providers = (try? await p) ?? []
        mcpServers = (try? await m) ?? []
        repos = (try? await r) ?? []
    }

    func provider(for conn: ConnectionRow) -> ConnectionProviderRow? {
        conn.provider ?? providers.first { $0.id == conn.providerId }
    }

    static let categories: [(String, String, String)] = [
        ("productivity", "Productivity", "briefcase"),
        ("database", "Databases", "cylinder"),
        ("cloud", "Cloud", "cloud"),
        ("knowledge", "Knowledge", "book"),
        ("custom", "Custom", "wrench"),
    ]

    var groupedProviders: [(String, String, [ConnectionProviderRow])] {
        var groups: [(String, String, [ConnectionProviderRow])] = []
        for cat in Self.categories {
            let items = providers.filter { $0.category == cat.0 }
            if !items.isEmpty { groups.append((cat.1, cat.2, items)) }
        }
        let known = Set(Self.categories.map(\.0))
        let other = providers.filter { !known.contains($0.category ?? "") }
        if !other.isEmpty { groups.append(("Other", "powerplug", other)) }
        return groups
    }
}

enum ConnectionIcons {
    static func symbol(for provider: ConnectionProviderRow?) -> String {
        switch provider?.icon {
        case "notion": return "doc.text"
        case "github": return "chevron.left.forwardslash.chevron.right"
        case "slack": return "bubble.left.and.bubble.right"
        case "linear": return "chart.bar"
        case "database": return "cylinder"
        case "sentry": return "ant"
        case "folder": return "folder"
        case "terminal": return "terminal"
        case "globe": return "globe"
        default: return "powerplug"
        }
    }

    static func statusColor(_ status: String?) -> Color {
        switch status {
        case "healthy", "connected": return Tone.success.color
        case "error", "failed": return Tone.danger.color
        default: return Tone.idle.color
        }
    }
}

/// Connections hub: active connections, the provider catalog (tap to add), and
/// global MCP servers — the same three things the web's Connections + Settings
/// pages expose for agent integrations.
struct ConnectionsView: View {
    @Environment(APIClient.self) private var api
    @Environment(MoreContext.self) private var context
    @State private var model = ConnectionsModel()
    @State private var newProvider: ConnectionProviderRow?
    @State private var showAddMcp = false
    @State private var pendingDelete: ConnectionRow?
    @State private var pendingMcpDelete: McpServerRow?
    @State private var errorMessage: String?

    var body: some View {
        List {
            if model.loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if let error = model.error, model.connections.isEmpty, model.providers.isEmpty {
                ErrorRow(error: error) { Task { await model.load(api: api) } }
            } else {
                Section {
                    if model.connections.isEmpty {
                        Text("No connections yet. Pick a provider below to add one.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(model.connections) { conn in
                        NavigationLink {
                            ConnectionDetailView(connectionId: conn.id, repos: model.repos) { await model.load(api: api) }
                        } label: {
                            connectionRow(conn)
                        }
                        .swipeActions(edge: .trailing) {
                            if context.isAdmin {
                                Button(role: .destructive) { pendingDelete = conn } label: { Label("Delete", systemImage: "trash") }
                            }
                        }
                    }
                } header: {
                    Text("Active connections (\(model.connections.count))")
                }

                ForEach(model.groupedProviders, id: \.0) { group in
                    Section {
                        ForEach(group.2) { p in
                            Button {
                                newProvider = p
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: ConnectionIcons.symbol(for: p))
                                        .frame(width: 24)
                                        .foregroundStyle(AppTheme.accent)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(p.name ?? p.slug ?? p.id).font(.subheadline).foregroundStyle(.primary)
                                        Text(p.description ?? "Connect to \(p.name ?? "service")")
                                            .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                    Spacer()
                                    if context.isAdmin { Image(systemName: "plus.circle").foregroundStyle(.secondary) }
                                }
                            }
                            .disabled(!context.isAdmin)
                        }
                    } header: {
                        Label(group.0, systemImage: group.1)
                    }
                }

                Section {
                    if model.mcpServers.isEmpty {
                        Text("No global MCP servers.").font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(model.mcpServers) { s in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(s.name ?? s.id).font(.subheadline)
                                Spacer()
                                if context.isAdmin {
                                    Toggle("", isOn: Binding(
                                        get: { s.enabled ?? true },
                                        set: { on in Task { await setMcpEnabled(s, on) } }
                                    ))
                                    .labelsHidden()
                                } else if s.enabled == false {
                                    StatusBadge(text: "Paused", tone: .idle)
                                }
                            }
                            Text(([s.command ?? ""] + (s.args ?? [])).joined(separator: " "))
                                .font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(2)
                        }
                        .swipeActions(edge: .trailing) {
                            if context.isAdmin {
                                Button(role: .destructive) { pendingMcpDelete = s } label: { Label("Delete", systemImage: "trash") }
                            }
                        }
                    }
                    if context.isAdmin {
                        Button { showAddMcp = true } label: { Label("Add global MCP server", systemImage: "plus") }
                    }
                } header: {
                    Text("Global MCP servers")
                } footer: {
                    Text("Applied to every repo's agent pods. Repo-scoped servers live on each repo's page.")
                }
            }
        }
        .navigationTitle("Connections")
        .task { await model.load(api: api) }
        .refreshable { await model.load(api: api) }
        .sheet(item: $newProvider) { p in
            NewConnectionSheet(provider: p, repos: model.repos) { await model.load(api: api) }
        }
        .sheet(isPresented: $showAddMcp) {
            McpServerSheet(repoId: nil) { await model.load(api: api) }
        }
        .confirmationDialog("Delete connection \"\(pendingDelete?.name ?? "")\"?", isPresented: Binding(
            get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }
        ), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                guard let c = pendingDelete else { return }
                Task {
                    do { try await api.deleteConnection(c.id); await model.load(api: api) }
                    catch { errorMessage = error.moreDescription }
                }
            }
        } message: { Text("This cannot be undone.") }
        .confirmationDialog("Delete MCP server \"\(pendingMcpDelete?.name ?? "")\"?", isPresented: Binding(
            get: { pendingMcpDelete != nil }, set: { if !$0 { pendingMcpDelete = nil } }
        ), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                guard let s = pendingMcpDelete else { return }
                Task {
                    do { try await api.deleteMcpServer(s.id); await model.load(api: api) }
                    catch { errorMessage = error.moreDescription }
                }
            }
        }
        .moreErrorAlert($errorMessage)
    }

    private func connectionRow(_ conn: ConnectionRow) -> some View {
        let provider = model.provider(for: conn)
        let tone: Tone? = conn.status == "error" || conn.status == "failed" ? .danger : nil
        return OptioRow(
            title: conn.name ?? conn.id,
            tone: tone,
            meta: Text.meta([
                provider?.name,
                conn.status.flatMap { $0 == "healthy" || $0 == "connected" ? nil : $0 },
                conn.lastCheckedAt.map { "checked \($0.relativeDescription)" },
            ]),
            trailing: conn.enabled == false ? "Paused" : nil,
            titleLineLimit: 1
        )
    }

    private func setMcpEnabled(_ s: McpServerRow, _ on: Bool) async {
        do {
            try await api.setMcpServerEnabled(s.id, enabled: on)
            await model.load(api: api)
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
