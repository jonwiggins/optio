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
        ("review", "Review"), ("attention", "Needs you"), ("done", "Done"), ("failed", "Failed"),
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
    @State private var toast: String?

    var body: some View {
        @Bindable var m = model
        List {
            Section {
                if let stats = model.stats {
                    StatStrip(items: [
                        StatItem("Running", stats.running, key: "running"),
                        StatItem("Queued", stats.queued, key: "queue"),
                        StatItem("In review", stats.ci + stats.review, key: "review"),
                        StatItem("Needs you", stats.needsAttention, tone: .accent, key: "attention"),
                        StatItem("Failed", stats.failed, tone: .danger, key: "failed"),
                    ], selected: model.stage.isEmpty ? nil : model.stage) { item in
                        withAnimation(.snappy) { model.stage = model.stage == item.key ? "" : item.key }
                    }
                } else {
                    SkeletonStrip(labels: ["Running", "Queued", "In review", "Needs you", "Failed"])
                }
            }
            .listRowInsets(EdgeInsets(top: Spacing.xs, leading: Spacing.l, bottom: Spacing.xs, trailing: Spacing.l))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)

            Section {
                ChipPicker(options: TasksListModel.stages, selection: $m.stage)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }

            if let error = model.error {
                ErrorRow(error: error, what: "tasks") { Task { await model.load(api: api) } }
            }
            if model.loading {
                SkeletonRows()
            } else if model.visible.isEmpty {
                EmptyState(
                    title: emptyTitle,
                    systemImage: "checklist",
                    message: model.query.isEmpty && model.stage.isEmpty ? "Put an agent to work in a repo." : "Nothing matches this filter.",
                    actionTitle: model.query.isEmpty && model.stage.isEmpty ? "New task" : nil,
                    action: { showNew = true }
                )
                .listRowSeparator(.hidden)
            } else {
                ForEach(model.visible) { task in
                    NavigationLink(value: task.id) {
                        TaskRowView(task: task, subtasks: model.subtasks(of: task))
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if ["queued", "pending", "running", "provisioning", "needs_attention", "pr_opened"].contains(task.state) {
                            Button("Cancel", systemImage: "xmark", role: .destructive) { Task { await act("cancel", task) } }
                        }
                        if task.state == "failed" || task.state == "cancelled" {
                            Button("Retry", systemImage: "arrow.clockwise") { Task { await act("retry", task) } }.tint(.primary)
                        }
                    }
                }
                if model.nextCursor != nil {
                    Button {
                        Task { await model.loadMore(api: api) }
                    } label: {
                        HStack { Spacer(); if model.loadingMore { ProgressView() } else { Text("Load more").font(.subheadline) }; Spacer() }
                    }
                }
            }
        }
        .listStyle(.plain)
        .animation(.snappy, value: model.stage)
        .searchable(text: $m.query, prompt: "Search")
        .navigationDestination(for: String.self) { id in TaskDetailView(taskId: id) }
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
                } label: { Image(systemName: "line.3.horizontal.decrease") }
                Button { showNew = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New task")
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
                        toast = which == "retry" ? "Retrying failed tasks" : "Cancelling active tasks"
                        await model.load(api: api, quiet: true)
                    } catch { actionError = error }
                }
            }
        }
        .errorToast($actionError)
        .toast(toast, tone: .success) { toast = nil }
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

    private var emptyTitle: String {
        switch model.stage {
        case "": return model.query.isEmpty ? "No tasks yet" : "No matching tasks"
        case "attention": return "Nothing needs you"
        case "failed": return "No failed tasks"
        case "done": return "Nothing finished yet"
        default: return "No \(model.stage) tasks"
        }
    }

    private func act(_ verb: String, _ task: TaskRow) async {
        do {
            if verb == "retry" { try await api.retryTask(task.id) } else { try await api.cancelTask(task.id) }
            toast = verb == "retry" ? "Retrying “\(task.title)”" : "Cancelled “\(task.title)”"
            await model.load(api: api, quiet: true)
        } catch { actionError = error }
    }
}

/// Tasks row: dot + title + `repo · agent · #519 · $0.78` + trailing time / terminal state.
struct TaskRowView: View {
    let task: TaskRow
    var subtasks: [TaskRow] = []

    private var stalled: Bool { task.isStalled == true && task.state == "running" }

    private var tone: Tone {
        if stalled { return .accent }
        return Tone.forState(task.state)
    }

    private var meta: Text? {
        var parts: [Text?] = [Text(task.repoShortName)]
        if let n = task.prNumber { parts.append(Text.mono("#\(n)")) }
        else if task.prUrl != nil, let last = task.prUrl?.split(separator: "/").last { parts.append(Text.mono("#\(last)")) }
        parts.append(Text(RunFormatting.agentLabel(task.agentType)))
        if let cost = Cost.formatIfNonZero(task.costUsd) { parts.append(Text(cost)) }
        if task.taskType == "review" { parts.append(Text("review")) }
        return Text.meta(parts)
    }

    private var trailing: (String, Tone?)? {
        switch task.state {
        case "completed":
            if task.prState == "merged" { return ("Merged", .success) }
            return ("Done", nil)
        case "failed": return ("Failed" + (task.completedAt.map { " \($0.relativeDescription)" } ?? ""), .danger)
        case "cancelled": return ("Cancelled", nil)
        case "pr_opened":
            if let checks = task.prChecksStatus, checks != "none" {
                return ("CI \(checks)", checks == "passing" ? .success : checks == "failing" ? .danger : nil)
            }
            return ("PR open", nil)
        case "needs_attention": return ("Needs you", .accent)
        default:
            if stalled { return ("Stalled", .accent) }
            return (task.createdAt?.relativeDescription ?? "", nil)
        }
    }

    private var footer: Text? {
        if (task.state == "failed" || task.state == "needs_attention"), let err = task.errorMessage, !err.isEmpty {
            return Text(err)
        }
        if task.pendingReason == "waiting_for_off_peak" { return Text("Held for off-peak window") }
        if !subtasks.isEmpty {
            return Text("\(subtasks.count) subtask\(subtasks.count == 1 ? "" : "s") · \(subtasks.filter { $0.state == "completed" }.count) done")
        }
        return nil
    }

    var body: some View {
        OptioRow(
            title: task.title,
            tone: tone,
            meta: meta,
            trailing: trailing?.0,
            trailingTone: trailing?.1,
            footer: footer
        )
    }
}
