import SwiftUI
import Observation

@Observable @MainActor
final class IssuesListModel {
    var issues: [IssueRow] = []
    var repos: [RunRepoRow] = []
    var repoId = ""
    var state = "open"
    var loading = false
    var loaded = false
    var error: Error?

    var unassigned: [IssueRow] { issues.filter { $0.isAssignable } }

    func load(api: APIClient) async {
        loading = true
        do {
            if repos.isEmpty { repos = (try? await api.runListRepos()) ?? [] }
            issues = try await api.listIssues(repoId: repoId.isEmpty ? nil : repoId, state: state == "open" ? nil : state)
            error = nil
        } catch is CancellationError {
        } catch { self.error = error }
        loading = false
        loaded = true
    }

    func markAssigned(_ issue: IssueRow, taskId: String?) {
        if let i = issues.firstIndex(where: { $0.identity == issue.identity }) {
            issues[i].optioTask = IssueRow.OptioTaskRef(taskId: taskId, state: "queued")
            issues[i].labels = (issues[i].labels ?? []) + ["optio"]
        }
    }
}

struct IssuesListView: View {
    @Environment(APIClient.self) private var api
    @State private var model = IssuesListModel()
    @State private var confirmBulk = false
    @State private var bulkBusy = false
    @State private var notice: String?
    @State private var assignError: Error?

    var body: some View {
        @Bindable var m = model
        List {
            Section {
                ChipPicker(options: [("open", "Open"), ("closed", "Closed"), ("all", "All")], selection: $m.state)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if let error = model.error { ErrorRow(error: error, what: "issues") { Task { await model.load(api: api) } } }
            if !model.loaded {
                SkeletonRows()
            } else if model.issues.isEmpty {
                EmptyState(
                    title: model.state == "all" ? "No issues" : "No \(model.state) issues",
                    systemImage: "circle.dotted",
                    message: model.repos.isEmpty ? "Add a repo first under More › Repos." : "Issues from your repos appear here."
                )
                .listRowSeparator(.hidden)
            }
            ForEach(model.issues, id: \.identity) { issue in
                NavigationLink(value: IssueRoute(issue: issue)) { IssueRowView(issue: issue) }
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        if issue.isAssignable {
                            Button("Assign", systemImage: "bolt.fill") { Task { await assign(issue) } }.tint(AppTheme.accent)
                        }
                    }
            }
        }
        .listStyle(.plain)
        .dimmedWhileLoading(model.loading && model.loaded)
        .animation(.snappy, value: model.state)
        .navigationDestination(for: IssueRoute.self) { route in
            IssueDetailView(issue: route.issue) { taskId in model.markAssigned(route.issue, taskId: taskId) }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Repo", selection: $m.repoId) {
                        Text("All repos").tag("")
                        ForEach(model.repos) { Text($0.displayName).tag($0.id) }
                    }
                    if !model.unassigned.isEmpty {
                        Divider()
                        Button("Assign all (\(model.unassigned.count))", systemImage: "bolt") { confirmBulk = true }
                    }
                } label: { if bulkBusy { ProgressView() } else { Image(systemName: "line.3.horizontal.decrease") } }
            }
        }
        .confirmationDialog("Assign \(model.unassigned.count) issues to Optio?", isPresented: $confirmBulk, titleVisibility: .visible) {
            Button("Assign all") { Task { await assignAll() } }
        }
        .toast(notice, tone: .success) { notice = nil }
        .errorToast($assignError)
        .task(id: model.repoId + "|" + model.state) { await model.load(api: api) }
        .refreshable { await model.load(api: api) }
    }

    private func assign(_ issue: IssueRow) async {
        guard let n = issue.numberInt, let repoId = issue.repo?.id else { return }
        do {
            let task = try await api.assignIssue(number: n, repoId: repoId, title: issue.title, body: issue.body ?? "", agentType: nil)
            model.markAssigned(issue, taskId: task.id)
            notice = "Assigned \(issue.numberText) to Optio"
        } catch { assignError = error }
    }

    private func assignAll() async {
        bulkBusy = true
        var assigned = 0
        let targets = model.unassigned
        for issue in targets {
            guard let n = issue.numberInt, let repoId = issue.repo?.id else { continue }
            if let task = try? await api.assignIssue(number: n, repoId: repoId, title: issue.title, body: issue.body ?? "", agentType: nil) {
                model.markAssigned(issue, taskId: task.id)
                assigned += 1
            }
        }
        bulkBusy = false
        notice = "Assigned \(assigned) of \(targets.count) issues"
    }
}

struct IssueRoute: Hashable {
    let issue: IssueRow
    static func == (a: IssueRoute, b: IssueRoute) -> Bool { a.issue.identity == b.issue.identity }
    func hash(into h: inout Hasher) { h.combine(issue.identity) }
}

/// `dot · title · #12 · owner/repo · @author · 2h`, trailing Optio task state.
struct IssueRowView: View {
    let issue: IssueRow

    private var trailing: (String, Tone?)? {
        guard let t = issue.optioTask else { return issue.isAssignable ? nil : ("auto-sync", nil) }
        switch t.state {
        case "completed": return ("Done", .success)
        case "pr_opened": return ("PR open", nil)
        case "failed": return ("Failed", .danger)
        case "needs_attention": return ("Needs you", .accent)
        case let s?: return (s.replacingOccurrences(of: "_", with: " ").capitalized, nil)
        case nil: return ("Assigned", nil)
        }
    }

    var body: some View {
        OptioRow(
            title: issue.title,
            tone: issue.optioTask.map { Tone.forState($0.state) },
            meta: Text.meta([Text.mono(issue.numberText), (issue.repo?.fullName ?? issue.source).map { Text($0) }, issue.author.map { Text("@\($0)") }, issue.updatedAt.map { Text($0.relativeDescription) }]),
            trailing: trailing?.0,
            trailingTone: trailing?.1,
            footer: (issue.labels?.isEmpty == false) ? Text(issue.labels!.joined(separator: " · ")) : nil
        )
    }
}

/// Pushed issue detail: read it, open on the git host, or create a Task from it
/// (what the web's "Assign to Optio" does).
struct IssueDetailView: View {
    let issue: IssueRow
    var onAssigned: (String?) -> Void
    @Environment(APIClient.self) private var api
    @State private var agentType = ""
    @State private var assigning = false
    @State private var error: Error?
    @State private var createdTaskId: String?

    var body: some View {
        List {
            Section {
                Text(issue.title).font(.body)
                HStack(spacing: Spacing.s) {
                    Text(issue.numberText).font(.monoFootnote)
                    Text(issue.repo?.fullName ?? issue.source ?? "")
                    if let s = issue.state { StatusBadge(text: s, tone: s == "open" ? .working : .idle) }
                }.font(.footnote).foregroundStyle(.secondary)
                if let a = issue.author { LabeledContent("Author", value: "@\(a)") }
                if let a = issue.assignee { LabeledContent("Assignee", value: "@\(a)") }
                if let url = issue.url.flatMap(URL.init(string:)) { Link("Open on \(issue.source ?? "GitHub")", destination: url) }
            }
            if let body = issue.body, !body.isEmpty {
                Section("Description") { Text(body).font(.callout).textSelection(.enabled) }
            }
            Section("Optio") {
                if let taskId = createdTaskId ?? issue.optioTask?.taskId {
                    NavigationLink(value: taskId) {
                        Label(createdTaskId != nil ? "Task created — open it" : "Open the task working on this issue", systemImage: "checklist")
                    }
                } else if issue.isAssignable {
                    Picker("Agent", selection: $agentType) {
                        Text("Repo default").tag("")
                        ForEach(RunFormatting.agentTypes, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    Button {
                        assign()
                    } label: {
                        HStack { if assigning { ProgressView() } else { Label("Assign to Optio", systemImage: "bolt.fill") } }
                    }
                    .disabled(assigning)
                } else {
                    Text("External tracker tickets are picked up automatically by the ticket-sync worker.").font(.footnote).foregroundStyle(.secondary)
                }
                if let error { ErrorRow(error: error) }
            }
        }
        .navigationTitle(issue.numberText.isEmpty ? "Issue" : issue.numberText)
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: String.self) { id in TaskDetailView(taskId: id) }
    }

    private func assign() {
        guard let n = issue.numberInt, let repoId = issue.repo?.id else { return }
        assigning = true
        Task {
            do {
                let task = try await api.assignIssue(number: n, repoId: repoId, title: issue.title, body: issue.body ?? "", agentType: agentType.isEmpty ? nil : agentType)
                createdTaskId = task.id
                onAssigned(task.id)
            } catch { self.error = error }
            assigning = false
        }
    }
}
