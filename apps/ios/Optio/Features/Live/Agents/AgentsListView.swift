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
    @State private var filter: String? = nil

    private var visible: [PersistentAgent] {
        let base = showArchived ? agents : agents.filter { $0.state != .archived }
        guard let filter else { return base }
        switch filter {
        case "running": return base.filter { [.running, .queued, .provisioning].contains($0.state) }
        case "idle": return base.filter { $0.state == .idle }
        case "paused": return base.filter { $0.state == .paused }
        case "failed": return base.filter { $0.state == .failed }
        default: return base
        }
    }

    var body: some View {
        List {
            Section {
                if let stats {
                    StatStrip(items: [
                        StatItem("Running", stats.running + stats.queued, key: "running"),
                        StatItem("Idle", stats.idle, key: "idle"),
                        StatItem("Needs you", stats.paused, tone: .accent, key: "paused"),
                        StatItem("Failed", stats.failed, tone: .danger, key: "failed"),
                    ], selected: filter) { item in
                        withAnimation(.snappy) { filter = filter == item.key ? nil : item.key }
                    }
                } else if !loaded {
                    SkeletonStrip(labels: ["Running", "Idle", "Needs you", "Failed"])
                }
            }
            .listRowInsets(EdgeInsets(top: Spacing.xs, leading: Spacing.l, bottom: Spacing.xs, trailing: Spacing.l))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)

            if let error {
                ErrorRow(error: error, what: "agents") { Task { await refresh() } }
            }
            if !loaded && error == nil {
                SkeletonRows()
            } else if loaded && visible.isEmpty {
                EmptyState(
                    title: filter == nil ? "No agents yet" : "No \(filter == "paused" ? "paused" : filter!) agents",
                    systemImage: "cpu",
                    message: filter == nil ? "A long-lived agent that listens for messages and events and wakes to do work." : "Nothing matches this filter.",
                    actionTitle: filter == nil ? "New session" : nil,
                    action: { showNew = true }
                )
                .listRowSeparator(.hidden)
            }
            ForEach(visible, id: \.id) { agent in
                NavigationLink(value: agent.id) {
                    AgentRow(agent: agent)
                }
            }
        }
        .listStyle(.plain)
        .animation(.snappy, value: filter)
        .navigationDestination(for: String.self) { id in
            AgentDetailView(agentId: id)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showNew = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New session")
            }
            ToolbarItem(placement: .secondaryAction) {
                Toggle("Show archived", isOn: $showArchived)
            }
        }
        .sheet(isPresented: $showNew) { NewSessionSheet() }
        .refreshable { await refresh() }
        .task {
            await refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                await refresh()
            }
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

/// `dot · name · @slug · runtime · last turn 2h · $0.78`, trailing terminal state.
struct AgentRow: View {
    let agent: PersistentAgent

    private var trailing: (String, Tone?)? {
        switch agent.state {
        case .paused: return ("Paused", .accent)
        case .failed: return ("Failed", .danger)
        case .archived: return ("Archived", nil)
        case .idle: return agent.enabled ? nil : ("Disabled", nil)
        default: return (agent.state.rawValue.capitalized, nil)
        }
    }

    private var footer: Text? {
        if agent.consecutiveFailures > 0 { return Text("\(Int(agent.consecutiveFailures)) consecutive failures") }
        if let d = agent.description, !d.isEmpty { return Text(d) }
        return nil
    }

    var body: some View {
        OptioRow(
            title: agent.name,
            tone: Tone.forState(agent.state.rawValue),
            meta: Text.meta([
                Text.mono("@\(agent.slug)"),
                Text(agent.agentRuntime),
                Text(agent.lastTurnAt.map { "last turn \($0.relativeDescription)" } ?? "never run"),
                Cost.formatIfNonZero(agent.totalCostUsd).map { Text($0) },
            ]),
            trailing: trailing?.0,
            trailingTone: trailing?.1,
            footer: footer
        )
    }
}
