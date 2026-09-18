import SwiftUI

/// Persistent Agents list — mirrors `apps/web/src/app/agents/page.tsx` plus the
/// `/api/persistent-agents/stats` bar. Polls every 10s while visible.
struct AgentsListView: View {
    @Environment(APIClient.self) private var api
    @State private var agents: [PersistentAgent] = []
    @State private var stats: PersistentAgentStats?
    @State private var error: Error?
    @State private var loaded = false
    @State private var showNew = false
    @State private var showArchived = false

    private var visible: [PersistentAgent] {
        showArchived ? agents : agents.filter { $0.state != .archived }
    }

    var body: some View {
        List {
            if let stats {
                Section {
                    statsRow(stats)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }
            if let error {
                ErrorBanner(error: error) { Task { await refresh() } }
                    .listRowBackground(Color.clear)
            }
            if loaded && visible.isEmpty {
                EmptyState(
                    title: "No agents yet",
                    systemImage: "cpu",
                    message: "Create an agent that lives in your workspace, listens for messages and events, and wakes to do work."
                )
                .listRowBackground(Color.clear)
            }
            ForEach(visible, id: \.id) { agent in
                NavigationLink(value: agent.id) {
                    AgentRow(agent: agent)
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if !loaded && error == nil { ProgressView() }
        }
        .navigationDestination(for: String.self) { id in
            AgentDetailView(agentId: id)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showNew = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New agent")
            }
            ToolbarItem(placement: .secondaryAction) {
                Toggle("Show archived", isOn: $showArchived)
            }
        }
        .sheet(isPresented: $showNew) {
            AgentFormSheet(mode: .create) { _ in Task { await refresh() } }
        }
        .refreshable { await refresh() }
        .task {
            await refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                await refresh()
            }
        }
    }

    private func statsRow(_ s: PersistentAgentStats) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                StatTile(title: "Total", value: "\(s.total)")
                StatTile(title: "Running", value: "\(s.running)", color: .blue)
                StatTile(title: "Queued", value: "\(s.queued)", color: .orange)
                StatTile(title: "Idle", value: "\(s.idle)")
                StatTile(title: "Paused", value: "\(s.paused)", color: .yellow)
                StatTile(title: "Failed", value: "\(s.failed)", color: .red)
            }
            .padding(.horizontal)
            .padding(.vertical, 4)
        }
    }

    private func refresh() async {
        do {
            async let a = api.listPersistentAgents()
            async let s = api.livePersistentAgentStats()
            agents = try await a
            stats = try? await s
            error = nil
        } catch {
            self.error = error
        }
        loaded = true
    }
}

struct AgentRow: View {
    let agent: PersistentAgent

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(agent.name).font(.headline).lineLimit(1)
                Text("@\(agent.slug)").font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                StatusBadge(text: agent.state.rawValue, color: StateColor.color(for: agent.state.rawValue))
            }
            if let d = agent.description, !d.isEmpty {
                Text(d).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack(spacing: 12) {
                Label(agent.agentRuntime, systemImage: "cpu")
                Label(agent.podLifecycle.rawValue, systemImage: "shippingbox")
                if let t = agent.lastTurnAt {
                    Label("Last turn \(t.relativeDescription)", systemImage: "clock")
                } else {
                    Label("Never run", systemImage: "clock")
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            HStack(spacing: 12) {
                Text(String(format: "$%.4f", Double(agent.totalCostUsd) ?? 0)).font(.caption2.monospacedDigit())
                if agent.consecutiveFailures > 0 {
                    Label("\(Int(agent.consecutiveFailures)) failures", systemImage: "exclamationmark.triangle")
                        .font(.caption2).foregroundStyle(.red)
                }
                if !agent.enabled {
                    Text("disabled").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}
