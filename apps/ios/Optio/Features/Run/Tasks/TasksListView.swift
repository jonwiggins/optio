import SwiftUI
import Observation

@Observable @MainActor
final class TasksListModel {
    var tasks: [TaskRow] = []
    var stats: RunTaskStats?
    var loading = false
    var error: Error?
    var query = ""
    var stage = ""
    var agentType = ""
    var nextCursor: String?
    var loadingMore = false

    static let stages: [(String, String)] = [
        ("", "All"), ("queue", "Queue"), ("running", "Running"), ("ci", "CI"),
        ("review", "Review"), ("attention", "Attention"), ("done", "Done"), ("failed", "Failed"),
    ]

    var visible: [TaskRow] {
        let top = tasks.filter { $0.parentTaskId == nil }
        guard !stage.isEmpty else { return top }
        return top.filter { RunFormatting.stage(for: $0) == stage || (stage == "running" && RunFormatting.stage(for: $0) == "setup") }
    }

    func subtasks(of task: TaskRow) -> [TaskRow] { tasks.filter { $0.parentTaskId == task.id } }

    func load(api: APIClient, quiet: Bool = false) async {
        if !quiet { loading = tasks.isEmpty }
        do {
            async let s = api.runTaskStats()
            let res = try await api.searchTasks(q: query, agentType: agentType.isEmpty ? nil : agentType)
            tasks = res.tasks
            nextCursor = res.nextCursor
            stats = try? await s
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = error
        }
        loading = false
    }

    func loadMore(api: APIClient) async {
        guard let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let res = try await api.searchTasks(q: query, agentType: agentType.isEmpty ? nil : agentType, cursor: cursor)
            tasks += res.tasks
            nextCursor = res.nextCursor
        } catch { self.error = error }
    }
}

struct TasksListView: View {
    @Environment(APIClient.self) private var api
    @State private var model = TasksListModel()
    @State private var showNew = false
    @State private var pushTaskId: String?
    @State private var confirmBulk: String?
    @State private var actionError: Error?

    var body: some View {
        @Bindable var m = model
        List {
            if let stats = model.stats {
                Section {
                    StatGrid {
                            StatTile(title: "Running", value: "\(stats.running)", color: .blue)
                            StatTile(title: "Queued", value: "\(stats.queued)", color: .orange)
                            StatTile(title: "CI", value: "\(stats.ci)", color: AppTheme.accent)
                            StatTile(title: "Review", value: "\(stats.review)", color: AppTheme.accent)
                            StatTile(title: "Attention", value: "\(stats.needsAttention)", color: .yellow)
                            StatTile(title: "Failed", value: "\(stats.failed)", color: .red)
                            StatTile(title: "Done", value: "\(stats.completed)", color: .green)
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
            }
            Section {
                ChipPicker(options: TasksListModel.stages, selection: $m.stage)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            if let error = model.error {
                ErrorBanner(error: error) { Task { await model.load(api: api) } }
            }
            if model.loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if model.visible.isEmpty {
                EmptyState(title: "No tasks", systemImage: "checklist", message: model.query.isEmpty && model.stage.isEmpty ? "Create a task to put an agent to work in a repo." : "Nothing matches these filters.")
            } else {
                ForEach(model.visible) { task in
                    NavigationLink(value: task.id) {
                        TaskRowView(task: task, subtasks: model.subtasks(of: task))
                    }
                }
                if model.nextCursor != nil {
                    Button {
                        Task { await model.loadMore(api: api) }
                    } label: {
                        HStack { Spacer(); if model.loadingMore { ProgressView() } else { Text("Load more") }; Spacer() }
                    }
                }
            }
        }
        .listStyle(.plain)
        .searchable(text: $m.query, prompt: "Search titles and prompts")
        .navigationDestination(for: String.self) { id in TaskDetailView(taskId: id) }
        .navigationTitle("Tasks")
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu {
                    Picker("Agent", selection: $m.agentType) {
                        Text("All agents").tag("")
                        ForEach(RunFormatting.agentTypes, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    Divider()
                    Button("Retry all failed") { confirmBulk = "retry" }
                    Button("Cancel all active", role: .destructive) { confirmBulk = "cancel" }
                } label: { Image(systemName: "line.3.horizontal.decrease.circle") }
                Button { showNew = true } label: { Image(systemName: "plus") }
            }
        }
        .sheet(isPresented: $showNew) {
            NewTaskSheet { created in pushTaskId = created.id }
        }
        .navigationDestination(item: $pushTaskId) { id in TaskDetailView(taskId: id) }
        .confirmationDialog(confirmBulk == "retry" ? "Retry all failed tasks?" : "Cancel all running and queued tasks?", isPresented: Binding(get: { confirmBulk != nil }, set: { if !$0 { confirmBulk = nil } }), titleVisibility: .visible) {
            Button(confirmBulk == "retry" ? "Retry failed" : "Cancel active", role: confirmBulk == "retry" ? nil : .destructive) {
                let which = confirmBulk
                Task {
                    do {
                        if which == "retry" { try await api.post("/api/tasks/bulk/retry-failed") }
                        else { try await api.post("/api/tasks/bulk/cancel-active") }
                        await model.load(api: api, quiet: true)
                    } catch { actionError = error }
                }
            }
        }
        .alert("Action failed", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK") {}
        } message: { Text(actionError?.localizedDescription ?? "") }
        .task { await model.load(api: api) }
        .task(id: model.query + "|" + model.agentType) {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await model.load(api: api, quiet: true)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled else { return }
                await model.load(api: api, quiet: true)
            }
        }
        .refreshable { await model.load(api: api, quiet: true) }
    }
}

struct TaskRowView: View {
    let task: TaskRow
    var subtasks: [TaskRow] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                Text(task.title).font(.body.weight(.medium)).lineLimit(2)
                Spacer(minLength: 8)
                StatusBadge(text: task.isStalled == true && task.state == "running" ? "stalled" : task.state, color: task.isStalled == true && task.state == "running" ? .yellow : StateColor.color(for: task.state))
            }
            HStack(spacing: 10) {
                Label(task.repoShortName, systemImage: "shippingbox").lineLimit(1)
                Label(RunFormatting.agentLabel(task.agentType), systemImage: "cpu")
                if task.taskType == "review" { Text("review").foregroundStyle(AppTheme.accent) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                if let created = task.createdAt { Text(created.relativeDescription) }
                if let pr = task.prLabel { Label(pr, systemImage: "arrow.triangle.pull").foregroundStyle(AppTheme.accent) }
                if let cost = task.costText { Text(cost) }
                if let checks = task.prChecksStatus, checks != "none" { Text("CI \(checks)").foregroundStyle(checks == "passing" ? .green : checks == "failing" ? .red : .secondary) }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            if task.state == "failed" || task.state == "needs_attention", let err = task.errorMessage {
                Text(err).font(.caption2).foregroundStyle(task.state == "failed" ? .red : .yellow).lineLimit(2)
            }
            if task.pendingReason == "waiting_for_off_peak" {
                Label("Held for off-peak window", systemImage: "moon").font(.caption2).foregroundStyle(.secondary)
            }
            if !subtasks.isEmpty {
                Text("\(subtasks.count) subtask\(subtasks.count == 1 ? "" : "s") · \(subtasks.filter { $0.state == "completed" }.count) done")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}
