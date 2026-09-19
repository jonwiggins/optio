import SwiftUI
import Observation

@Observable @MainActor
final class ScheduledListModel {
    struct Item: Identifiable { var config: TaskConfigRow; var triggers: [TriggerRow]; var id: String { config.id } }
    var items: [Item] = []
    var loading = false
    var loaded = false
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
        loaded = true
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
            if let error = model.error { ErrorRow(error: error, what: "scheduled tasks") { Task { await model.load(api: api) } } }
            if !model.loaded {
                SkeletonRows()
            } else if model.items.isEmpty {
                EmptyState(title: "Nothing scheduled", systemImage: "calendar", message: "Save a task blueprint and attach a schedule, webhook or ticket trigger.", actionTitle: "New session") { showNew = true }
                    .listRowSeparator(.hidden)
            }
            ForEach(model.items) { item in
                NavigationLink(value: item.config.id) {
                    ScheduledRowView(config: item.config, triggers: item.triggers, busy: model.busyId == item.id)
                }
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    Button("Run now", systemImage: "play.fill") {
                        Task { await model.run(api: api, id: item.id) { "Spawned task \(try await api.runTaskConfig(item.id).prefix(8)) from “\(item.config.name)”" } }
                    }.tint(AppTheme.accent)
                }
                .swipeActions(edge: .trailing) {
                    Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = item.config }
                    Button(item.config.enabled ? "Pause" : "Resume", systemImage: item.config.enabled ? "pause" : "play") {
                        Task { await model.run(api: api, id: item.id) { try await api.setTaskConfigEnabled(item.id, !item.config.enabled); return nil } }
                    }.tint(.primary)
                }
            }
        }
        .listStyle(.plain)
        .navigationDestination(for: String.self) { id in ScheduledDetailView(configId: id) }
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { showNew = true } label: { Image(systemName: "plus") }.accessibilityLabel("New session") } }
        .sheet(isPresented: $showNew) { NewSessionSheet() }
        .confirmationDialog("Delete “\(pendingDelete?.name ?? "")”? This removes the schedule and all its triggers.", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                guard let c = pendingDelete else { return }
                Task { await model.run(api: api, id: c.id) { try await api.deleteTaskConfig(c.id); return nil } }
            }
        }
        .errorToast(Binding(get: { model.actionError }, set: { model.actionError = $0 }))
        .toast(model.notice, tone: .success) { model.notice = nil }
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

/// `name · repo · branch · agent`, one trigger summary line, trailing next-fire / Paused.
struct ScheduledRowView: View {
    let config: TaskConfigRow
    var triggers: [TriggerRow]
    var busy = false

    private var triggerLine: Text? {
        guard let t = triggers.first else { return Text("Manual only") }
        var parts: [Text?] = [Text(ScheduleFormat.humanize(t))]
        if t.type == "schedule", let next = t.nextFireAt { parts.append(Text("next \(next.relativeDescription)")) }
        if triggers.count > 1 { parts.append(Text("+\(triggers.count - 1) more")) }
        if !t.enabled { parts.append(Text("trigger off")) }
        return Text.meta(parts)
    }

    var body: some View {
        OptioRow(
            title: config.name,
            tone: busy ? .working : nil,
            meta: Text.meta([Text(RunFormatting.repoShortName(config.repoUrl)), Text.mono(config.repoBranch ?? "main"), Text(RunFormatting.agentLabel(config.agentType))]),
            trailing: busy ? "Running…" : (config.enabled ? nil : "Paused"),
            footer: triggerLine
        )
    }
}

enum ScheduleFormat {
    /// "Every day 09:00" / "Every Monday 09:00" / "Every hour" for common cron shapes; raw cron otherwise.
    static func humanize(_ t: TriggerRow) -> String {
        switch t.type {
        case "schedule": return t.cronExpression.map(cron) ?? "Schedule"
        case "webhook": return "Webhook"
        case "ticket":
            let src = (t.ticketSource ?? "github").capitalized
            return t.ticketLabels.isEmpty ? "\(src) tickets" : "\(src) tickets · \(t.ticketLabels.joined(separator: ", "))"
        default: return "Manual"
        }
    }

    static func cron(_ expr: String) -> String {
        let f = expr.split(separator: " ").map(String.init)
        guard f.count == 5, let m = Int(f[0]) else { return expr }
        let time: (String) -> String = { h in String(format: "%02d:%02d", Int(h) ?? 0, m) }
        let days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        if f[1] == "*" { return m == 0 ? "Every hour" : "Every hour at :\(String(format: "%02d", m))" }
        guard Int(f[1]) != nil else { return expr }
        if f[2] == "*", f[3] == "*" {
            if f[4] == "*" { return "Every day \(time(f[1]))" }
            if f[4] == "1-5" { return "Weekdays \(time(f[1]))" }
            if let d = Int(f[4]), d >= 0, d < 7 { return "Every \(days[d]) \(time(f[1]))" }
        }
        return expr
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
