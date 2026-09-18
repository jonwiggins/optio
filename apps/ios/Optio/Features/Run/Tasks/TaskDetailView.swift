import SwiftUI
import Observation

@Observable @MainActor
final class TaskDetailModel {
    let id: String
    var task: TaskRow?
    var pendingReason: String?
    var stallInfo: TaskDetailResponse.StallInfo?
    var events: [TaskEvent] = []
    var subtasks: [TaskRow] = []
    var dependencies: [TaskRow] = []
    var dependents: [TaskRow] = []
    var activity: [TaskActivityItem] = []
    var error: Error?
    var actionError: Error?
    var busy = false
    var notice: String?

    init(id: String) { self.id = id }

    func load(api: APIClient) async {
        do {
            async let detail = api.getTask(id)
            async let ev = api.taskEvents(id)
            let d = try await detail
            task = d.task
            pendingReason = d.pendingReason
            stallInfo = d.stallInfo
            events = (try? await ev) ?? []
            error = nil
        } catch is CancellationError {
        } catch { self.error = error }
        async let s = api.subtasks(id)
        async let deps = api.taskDependencies(id)
        async let dependents = api.taskDependents(id)
        async let act = api.taskActivity(id)
        subtasks = (try? await s) ?? []
        dependencies = (try? await deps) ?? []
        self.dependents = (try? await dependents) ?? []
        activity = (try? await act) ?? []
    }

    func run(api: APIClient, success: String? = nil, _ op: @escaping () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do {
            try await op()
            if let success { notice = success }
            await load(api: api)
        } catch { actionError = error }
    }

    // State predicates mirror apps/web/src/app/tasks/[id]/page.tsx
    var state: String { task?.state ?? "" }
    var canCancel: Bool { ["running", "queued", "provisioning", "needs_attention"].contains(state) }
    var canRetry: Bool { ["failed", "cancelled"].contains(state) }
    var canStart: Bool { state == "pending" && task?.taskType != "step" }
    var canResume: Bool { ["needs_attention", "failed"].contains(state) && task?.sessionId != nil }
    var canMessageRunning: Bool { state == "running" && task?.agentType == "claude-code" }
    var canMessageStopped: Bool { ["needs_attention", "pr_opened", "failed", "cancelled"].contains(state) }
    var canMessage: Bool { canMessageRunning || canMessageStopped }
    var canForceRestart: Bool { ["needs_attention", "failed", "pr_opened"].contains(state) }
    var isTerminal: Bool { ["completed", "failed", "cancelled"].contains(state) }
    var isPlanReview: Bool { state == "needs_attention" && events.last?.trigger == "plan_review" }
}

struct TaskDetailView: View {
    let taskId: String
    /// Deep link `?compose=1`: land on Logs where the composer lives.
    var focusComposer = false
    @Environment(APIClient.self) private var api
    @State private var model: TaskDetailModel
    @State private var logs: TaskLogStream
    @State private var section = "logs"
    @State private var followed = false
    @State private var messageMode = "soft"
    @State private var confirm: String?
    @State private var showCreateSubtask = false
    @State private var showAddDependency = false

    init(taskId: String, focusComposer: Bool = false) {
        self.taskId = taskId
        self.focusComposer = focusComposer
        _model = State(initialValue: TaskDetailModel(id: taskId))
        _logs = State(initialValue: TaskLogStream(taskId: taskId))
        _followed = State(initialValue: FollowedTasks.contains(taskId))
    }

    var body: some View {
        VStack(spacing: 0) {
            if let task = model.task {
                header(task)
                banners(task)
                DetailTabs(options: [("logs", "Logs"), ("activity", "Activity"), ("subtasks", "Subtasks"), ("deps", "Deps")], selection: $section)
                switch section {
                case "logs": logsSection
                case "activity": activitySection
                case "subtasks": subtasksSection
                default: dependenciesSection
                }
            } else if let error = model.error {
                List { ErrorRow(error: error, what: "task") { Task { await model.load(api: api) } } }.listStyle(.plain)
            } else {
                List { SkeletonRows() }.listStyle(.plain)
            }
        }
        .navigationTitle(model.task?.title ?? "Task")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .task {
            if focusComposer { section = "logs" }
            await model.load(api: api)
            if model.isTerminal, followed { FollowedTasks.remove(taskId); followed = false }
            logs.onStateChanged = { Task { await model.load(api: api) } }
            logs.start(api: api)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled else { break }
                await model.load(api: api)
            }
        }
        .onDisappear { logs.stop() }
        .sheet(isPresented: $showCreateSubtask) {
            CreateSubtaskSheet(parentId: taskId) { Task { await model.load(api: api) } }
        }
        .sheet(isPresented: $showAddDependency) {
            AddDependencySheet(taskId: taskId, exclude: [taskId] + model.dependencies.map(\.id)) { Task { await model.load(api: api) } }
        }
        .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
            Button(confirmButton, role: .destructive) {
                let which = confirm
                Task {
                    switch which {
                    case "cancel": await model.run(api: api) { try await api.cancelTask(taskId) }
                    case "redo": await model.run(api: api, success: "Task reset and re-queued") { try await api.forceRedoTask(taskId) }
                    default: break
                    }
                }
            }
        }
        .errorToast(Binding(get: { model.actionError }, set: { model.actionError = $0 }))
        .toast(model.notice, tone: .success) { model.notice = nil }
    }

    private var confirmTitle: String {
        confirm == "redo" ? "Force redo clears all logs and results and re-runs the task from scratch." : "Cancel this task?"
    }
    private var confirmButton: String { confirm == "redo" ? "Force redo" : "Cancel task" }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        if !model.isTerminal {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    followed = FollowedTasks.toggle(taskId)
                } label: {
                    Image(systemName: followed ? "lock.rectangle.stack.fill" : "lock.rectangle.stack")
                }
                .tint(followed ? AppTheme.accent : nil)
                .accessibilityLabel(followed ? "Unfollow on Lock Screen" : "Follow on Lock Screen")
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if !model.isTerminal {
                    Button(followed ? "Unfollow on Lock Screen" : "Follow on Lock Screen", systemImage: followed ? "lock.rectangle.stack.fill" : "lock.rectangle.stack") {
                        followed = FollowedTasks.toggle(taskId)
                    }
                    Divider()
                }
                if model.canCancel { Button("Cancel task", systemImage: "xmark.circle", role: .destructive) { confirm = "cancel" } }
                if model.canRetry { Button("Retry", systemImage: "arrow.clockwise") { Task { await model.run(api: api) { try await api.retryTask(taskId) } } } }
                if model.canStart { Button("Start", systemImage: "play") { Task { await model.run(api: api) { try await api.retryTask(taskId) } } } }
                if model.canForceRestart { Button("Attempt resume", systemImage: "arrow.uturn.forward") { Task { await model.run(api: api, success: "Task re-queued on existing PR branch") { try await api.forceRestartTask(taskId) } } } }
                if model.state == "pr_opened" { Button("Request review", systemImage: "eye") { Task { await model.run(api: api, success: "Review agent launched") { try await api.launchReview(taskId) } } } }
                if model.pendingReason?.contains("off-peak") == true && model.state == "queued" {
                    Button("Run now", systemImage: "bolt") { Task { await model.run(api: api, success: "Task will run immediately") { try await api.runNowTask(taskId) } } }
                }
                Divider()
                Button("Force redo", systemImage: "arrow.counterclockwise", role: .destructive) { confirm = "redo" }
                Button("New subtask", systemImage: "plus.square.on.square") { showCreateSubtask = true }
                Button("Refresh", systemImage: "arrow.clockwise.circle") { Task { await model.load(api: api) } }
            } label: {
                if model.busy { ProgressView() } else { Image(systemName: "ellipsis.circle") }
            }
            .disabled(model.busy)
        }
    }

    // MARK: Header

    private func header(_ task: TaskRow) -> some View {
        let stalled = model.stallInfo?.isStalled == true && task.state == "running"
        var facts: [Text?] = []
        if let st = task.startedAt, let e = task.completedAt { facts.append(Text(RunFormatting.duration(e.timeIntervalSince(st) * 1000))) }
        else if let st = task.startedAt { facts.append(Text("started \(st.relativeDescription)")) }
        else if let c = task.createdAt { facts.append(Text("created \(c.relativeDescription)")) }
        if let m = task.modelUsed { facts.append(Text(InsightsFormat.modelShortName(m))) }
        facts.append(Text(RunFormatting.agentLabel(task.agentType)))
        if let cost = Cost.formatIfNonZero(task.costUsd) { facts.append(Text(cost)) }
        if let t = task.taskType, t != "coding" { facts.append(Text(t)) }
        var line2: [Text?] = [Text(task.repoShortName)]
        if let b = task.repoBranch { line2.append(Text.mono(b)) }
        if task.prUrl != nil {
            line2.append(Text.mono(task.prLabel ?? "PR"))
            if let checks = task.prChecksStatus, checks != "none" { line2.append(Text("CI \(checks)")) }
            if let review = task.prReviewStatus, review != "none" { line2.append(Text("review \(review.replacingOccurrences(of: "_", with: " "))")) }
            if let prState = task.prState, prState != "open" { line2.append(Text(prState)) }
        }
        let needsYou: String? = {
            if task.state == "needs_attention" { return task.errorMessage ?? "Needs your attention" }
            if stalled { return "Agent looks stuck — check the logs" }
            if task.prReviewStatus == "changes_requested" { return "Reviewer requested changes" }
            return nil
        }()
        return DetailHeader(
            state: stalled ? "stalled" : task.state,
            tone: stalled ? .working : (task.state == "needs_attention" ? .working : nil),
            line: Text.meta(facts),
            secondary: Text.meta(line2),
            needsYou: needsYou
        ) {
            if let prUrl = task.prUrl, let url = URL(string: prUrl) {
                Link(destination: url) { Image(systemName: "arrow.up.right.square") }
                    .font(.subheadline).foregroundStyle(.secondary)
                    .accessibilityLabel("Open pull request")
            }
        }
    }

    @ViewBuilder private func banners(_ task: TaskRow) -> some View {
        if let reason = model.pendingReason {
            banner(reason, icon: reason.contains("off-peak") ? "moon" : "clock", tone: .idle)
        }
        if let stall = model.stallInfo, stall.isStalled, task.state == "running" {
            banner("No activity for \(RunFormatting.duration(stall.silentForMs)).\(stall.lastLogSummary.map { " Last: \($0)" } ?? "")", icon: "exclamationmark.triangle", tone: .working)
        }
        if task.state == "failed", let err = task.errorMessage {
            banner(err, icon: "xmark.octagon", tone: .danger)
        }
        if task.state == "completed", let summary = task.resultSummary, !summary.isEmpty {
            banner(summary, icon: "checkmark.circle", tone: .success)
        }
        if model.isPlanReview {
            banner("Plan ready for review — check the agent output, then send feedback or approve.", icon: "list.clipboard", tone: .accent)
        }
    }

    private func banner(_ text: String, icon: String, tone: Tone) -> some View {
        NoticeBanner(tone: tone, systemImage: icon) { Text(text) }
            .padding(.horizontal, Spacing.l)
            .padding(.vertical, Spacing.xs)
    }

    // MARK: Logs

    private var logsSection: some View {
        VStack(spacing: 0) {
            if logs.entries.isEmpty {
                VStack(spacing: 6) {
                    Spacer()
                    ProgressView()
                    Text(logs.connected ? "Waiting for output…" : "Connecting…").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                }
            } else {
                AgentLogView(entries: logs.entries)
            }
            composer
        }
    }

    @ViewBuilder private var composer: some View {
        if model.canMessage || model.canResume {
            VStack(spacing: 4) {
                if model.canMessageRunning {
                    Picker("Mode", selection: $messageMode) {
                        Text("Soft (deliver between turns)").tag("soft")
                        Text("Interrupt (stop current work)").tag("interrupt")
                    }
                    .pickerStyle(.menu)
                    .font(.caption)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                } else if model.isPlanReview {
                    Button("Approve plan and start implementation") {
                        Task { await model.run(api: api) { try await api.resumeTask(taskId, prompt: "Plan approved. Proceed with implementation following your plan above.") } }
                    }
                    .buttonStyle(.borderedProminent).controlSize(.small).tint(AppTheme.accent)
                }
                ChatComposer(placeholder: model.canMessageRunning ? "Message the running agent…" : "Resume the agent with a message…", disabled: model.busy, autofocus: focusComposer) { text in
                    await model.run(api: api) {
                        if model.canMessage {
                            try await api.sendTaskMessage(taskId, content: text, mode: model.canMessageRunning ? messageMode : "soft")
                        } else {
                            try await api.resumeTask(taskId, prompt: text)
                        }
                        logs.appendLocal(text, interrupt: model.canMessageRunning && messageMode == "interrupt")
                    }
                }
            }
        } else if model.isTerminal, model.task?.sessionId == nil {
            Text("Resume unavailable — no session was captured for this task.")
                .font(.caption).foregroundStyle(.secondary).padding(8)
        }
    }

    // MARK: Activity (events + comments + messages)

    private var activitySection: some View {
        VStack(spacing: 0) {
            List {
                if model.activity.isEmpty {
                    Text("No activity yet").foregroundStyle(.secondary)
                }
                ForEach(model.activity) { item in
                    TaskActivityRow(item: item)
                        .swipeActions {
                            if item.type == "comment" {
                                Button("Delete", role: .destructive) {
                                    Task { await model.run(api: api) { try await api.deleteTaskComment(taskId, commentId: item.id) } }
                                }
                            }
                        }
                }
            }
            .listStyle(.plain)
            ChatComposer(placeholder: "Add a comment", disabled: model.busy) { text in
                await model.run(api: api) { try await api.addTaskComment(taskId, content: text) }
            }
        }
    }

    // MARK: Subtasks

    private var subtasksSection: some View {
        List {
            if model.subtasks.isEmpty {
                Text("No subtasks").foregroundStyle(.secondary)
            }
            ForEach(model.subtasks) { sub in
                NavigationLink(value: sub.id) { TaskRowView(task: sub) }
            }
            Button("New subtask", systemImage: "plus") { showCreateSubtask = true }
        }
        .listStyle(.plain)
        .navigationDestination(for: String.self) { id in TaskDetailView(taskId: id) }
    }

    // MARK: Dependencies

    private var dependenciesSection: some View {
        List {
            Section("Depends on") {
                if model.dependencies.isEmpty { Text("None").foregroundStyle(.secondary) }
                ForEach(model.dependencies) { dep in
                    NavigationLink(value: dep.id) { TaskRowView(task: dep) }
                        .swipeActions {
                            Button("Remove", role: .destructive) {
                                Task { await model.run(api: api) { try await api.removeTaskDependency(taskId, depId: dep.id) } }
                            }
                        }
                }
                Button("Add dependency", systemImage: "plus") { showAddDependency = true }
            }
            Section("Blocks") {
                if model.dependents.isEmpty { Text("None").foregroundStyle(.secondary) }
                ForEach(model.dependents) { dep in
                    NavigationLink(value: dep.id) { TaskRowView(task: dep) }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationDestination(for: String.self) { id in TaskDetailView(taskId: id) }
    }
}

struct TaskActivityRow: View {
    let item: TaskActivityItem

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            switch item.type {
            case "event":
                HStack(spacing: 6) {
                    if let from = item.fromState { StatusBadge(text: from, tone: Tone.forState(from)); Image(systemName: "arrow.right").font(.caption2) }
                    StatusBadge(text: item.toState ?? "", tone: Tone.forState(item.toState ?? ""))
                    if let name = item.user?.displayName { Text("by \(name)").font(.caption2).foregroundStyle(.secondary) }
                }
                if let trigger = item.trigger { Text(trigger.replacingOccurrences(of: "_", with: " ")).font(.caption).foregroundStyle(.secondary) }
                if let msg = item.message { Text(msg).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
            case "message":
                HStack(spacing: 6) {
                    Image(systemName: item.mode == "interrupt" ? "hand.raised.fill" : "paperplane.fill").font(.caption).foregroundStyle(item.mode == "interrupt" ? AnyShapeStyle(.secondary) : AnyShapeStyle(AppTheme.accent))
                    Text(item.user?.displayName ?? "You").font(.caption.weight(.semibold))
                    Text(item.ackedAt != nil ? "acked" : item.deliveredAt != nil ? "delivered" : "sending").font(.caption2).foregroundStyle(.tertiary)
                }
                Text(item.content ?? "").font(.body)
            default:
                HStack(spacing: 6) {
                    Image(systemName: "bubble.left").font(.caption).foregroundStyle(.secondary)
                    Text(item.user?.displayName ?? "Comment").font(.caption.weight(.semibold))
                }
                Text(item.content ?? "").font(.body)
            }
            if let d = item.createdAt { Text(d.relativeDescription).font(.caption2).foregroundStyle(.tertiary) }
        }
        .padding(.vertical, 2)
    }
}

struct CreateSubtaskSheet: View {
    let parentId: String
    var onCreated: () -> Void
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var prompt = ""
    @State private var taskType = "child"
    @State private var blocksParent = false
    @State private var saving = false
    @State private var error: Error?

    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $title)
                Picker("Type", selection: $taskType) {
                    Text("Child task").tag("child")
                    Text("Sequential step").tag("step")
                    Text("Code review").tag("review")
                }
                Toggle("Blocks parent until done", isOn: $blocksParent)
                Section("Prompt") {
                    TextEditor(text: $prompt).frame(minHeight: 140)
                }
                if let error { ErrorRow(error: error) }
            }
            .navigationTitle("New subtask")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        saving = true
                        Task {
                            do {
                                try await api.createSubtask(parentId, title: title, prompt: prompt, taskType: taskType, blocksParent: blocksParent)
                                onCreated(); dismiss()
                            } catch { self.error = error }
                            saving = false
                        }
                    }
                    .disabled(saving || title.trimmingCharacters(in: .whitespaces).isEmpty || prompt.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

struct AddDependencySheet: View {
    let taskId: String
    var exclude: [String]
    var onAdded: () -> Void
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var error: Error?

    var body: some View {
        NavigationStack {
            Loadable {
                try await api.searchTasks(q: query, limit: 100).tasks.filter { !exclude.contains($0.id) }
            } content: { tasks in
                List(tasks) { t in
                    Button {
                        Task {
                            do { try await api.addTaskDependencies(taskId, dependsOnIds: [t.id]); onAdded(); dismiss() }
                            catch { self.error = error }
                        }
                    } label: { TaskRowView(task: t) }
                    .buttonStyle(.plain)
                }
                .listStyle(.plain)
            }
            .id(query)
            .searchable(text: $query)
            .navigationTitle("Add dependency")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .errorToast(Binding(get: { error }, set: { error = $0 }))
        }
    }
}
