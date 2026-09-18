import SwiftUI
import Observation

@Observable @MainActor
final class ScheduledListModel {
    struct Item: Identifiable { var config: TaskConfigRow; var triggers: [TriggerRow]; var id: String { config.id } }
    var items: [Item] = []
    var loading = false
    var error: Error?
    var actionError: Error?
    var notice: String?
    var busyId: String?

    func load(api: APIClient) async {
        loading = items.isEmpty
        do {
            let configs = try await api.listTaskConfigs()
            items = await withTaskGroup(of: (Int, [TriggerRow]).self) { group in
                for (i, c) in configs.enumerated() {
                    group.addTask { (i, (try? await api.taskConfigTriggers(c.id)) ?? []) }
                }
                var out = configs.map { Item(config: $0, triggers: []) }
                for await (i, t) in group { out[i].triggers = t }
                return out
            }
            error = nil
        } catch is CancellationError {
        } catch { self.error = error }
        loading = false
    }

    func run(api: APIClient, id: String, _ op: @escaping () async throws -> String?) async {
        busyId = id
        defer { busyId = nil }
        do {
            if let msg = try await op() { notice = msg }
            await load(api: api)
        } catch { actionError = error }
    }
}

struct ScheduledListView: View {
    @Environment(APIClient.self) private var api
    @State private var model = ScheduledListModel()
    @State private var showNew = false
    @State private var pendingDelete: TaskConfigRow?

    var body: some View {
        List {
            if let error = model.error { ErrorBanner(error: error) { Task { await model.load(api: api) } } }
            if model.loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if model.items.isEmpty {
                EmptyState(title: "No scheduled tasks", systemImage: "calendar", message: "Save a Task blueprint and attach a schedule, webhook or ticket trigger.")
            }
            ForEach(model.items) { item in
                NavigationLink(value: item.config.id) {
                    ScheduledRowView(config: item.config, triggers: item.triggers)
                }
                .swipeActions(edge: .leading) {
                    Button("Run now", systemImage: "play.fill") {
                        Task { await model.run(api: api, id: item.id) { "Spawned task \(try await api.runTaskConfig(item.id).prefix(8)) from \"\(item.config.name)\"" } }
                    }.tint(AppTheme.accent)
                }
                .swipeActions(edge: .trailing) {
                    Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = item.config }
                    Button(item.config.enabled ? "Pause" : "Resume", systemImage: item.config.enabled ? "pause" : "play") {
                        Task { await model.run(api: api, id: item.id) { try await api.setTaskConfigEnabled(item.id, !item.config.enabled); return nil } }
                    }.tint(.orange)
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Scheduled")
        .navigationDestination(for: String.self) { id in ScheduledDetailView(configId: id) }
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { showNew = true } label: { Image(systemName: "plus") } } }
        .sheet(isPresented: $showNew) { TaskConfigFormSheet(existing: nil) { _ in Task { await model.load(api: api) } } }
        .confirmationDialog("Delete \"\(pendingDelete?.name ?? "")\"? This removes the schedule and all its triggers.", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                guard let c = pendingDelete else { return }
                Task { await model.run(api: api, id: c.id) { try await api.deleteTaskConfig(c.id); return nil } }
            }
        }
        .alert("Action failed", isPresented: Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })) { Button("OK") {} } message: { Text(model.actionError?.localizedDescription ?? "") }
        .alert(model.notice ?? "", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) { Button("OK") {} }
        .task {
            await model.load(api: api)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled else { break }
                await model.load(api: api)
            }
        }
        .refreshable { await model.load(api: api) }
    }
}

struct ScheduledRowView: View {
    let config: TaskConfigRow
    var triggers: [TriggerRow]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(config.name).font(.body.weight(.medium)).lineLimit(1)
                Spacer()
                StatusBadge(text: config.enabled ? "enabled" : "paused", color: config.enabled ? .green : .gray)
            }
            Text("\(RunFormatting.repoShortName(config.repoUrl)) · \(config.repoBranch ?? "main") · \(RunFormatting.agentLabel(config.agentType))")
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            if triggers.isEmpty {
                Text("Manual only").font(.caption2).foregroundStyle(.tertiary)
            } else {
                ForEach(triggers) { t in
                    HStack(spacing: 6) {
                        Image(systemName: triggerIcon(t.type)).font(.caption2)
                        Text(t.summary).font(.caption2.monospaced()).lineLimit(1)
                        if !t.enabled { Text("off").font(.caption2).foregroundStyle(.orange) }
                        if t.type == "schedule", let next = t.nextFireAt { Text("next \(next.relativeDescription)").font(.caption2) }
                        if let last = t.lastFiredAt { Text("last \(last.relativeDescription)").font(.caption2) }
                    }
                    .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

func triggerIcon(_ type: String) -> String {
    switch type {
    case "schedule": return "clock"
    case "webhook": return "link"
    case "ticket": return "ticket"
    default: return "hand.tap"
    }
}
