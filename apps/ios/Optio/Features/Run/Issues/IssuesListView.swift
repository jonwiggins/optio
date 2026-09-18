import SwiftUI
import Observation

@Observable @MainActor
final class IssuesListModel {
    var issues: [IssueRow] = []
    var repos: [RunRepoRow] = []
    var repoId = ""
    var state = "open"
    var loading = false
    var error: Error?

    var unassigned: [IssueRow] { issues.filter { $0.isAssignable } }

    func load(api: APIClient) async {
        loading = issues.isEmpty
        do {
            if repos.isEmpty { repos = (try? await api.runListRepos()) ?? [] }
            issues = try await api.listIssues(repoId: repoId.isEmpty ? nil : repoId, state: state == "open" ? nil : state)
            error = nil
        } catch is CancellationError {
        } catch { self.error = error }
        loading = false
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
    @State private var selected: IssueRow?
    @State private var confirmBulk = false
    @State private var bulkBusy = false
    @State private var notice: String?

    var body: some View {
        @Bindable var m = model
        List {
            if model.repos.count > 1 {
                Section {
                    ChipPicker(options: [("", "All repos")] + model.repos.map { ($0.id, $0.displayName) }, selection: $m.repoId)
                        .listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
                }
            }
            if let error = model.error { ErrorBanner(error: error) { Task { await model.load(api: api) } } }
            if model.loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if model.issues.isEmpty {
                EmptyState(title: "No open issues", systemImage: "circle.dotted", message: model.repos.isEmpty ? "Add a repo first under Admin → Repos." : "Issues will appear here from your configured repos.")
            }
            ForEach(model.issues, id: \.identity) { issue in
                Button { selected = issue } label: { IssueRowView(issue: issue) }
                    .buttonStyle(.plain)
            }
        }
        .listStyle(.plain)
        .navigationTitle("Issues")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("State", selection: $m.state) {
                        Text("Open").tag("open"); Text("Closed").tag("closed"); Text("All").tag("all")
                    }
                    if !model.unassigned.isEmpty {
                        Button("Assign all (\(model.unassigned.count))", systemImage: "bolt") { confirmBulk = true }
                    }
                } label: { if bulkBusy { ProgressView() } else { Image(systemName: "line.3.horizontal.decrease.circle") } }
            }
        }
        .sheet(item: Binding(get: { selected.map { IssueSelection(issue: $0) } }, set: { selected = $0?.issue })) { sel in
            IssueDetailSheet(issue: sel.issue) { taskId in model.markAssigned(sel.issue, taskId: taskId) }
        }
        .confirmationDialog("Assign \(model.unassigned.count) issues to Optio?", isPresented: $confirmBulk, titleVisibility: .visible) {
            Button("Assign all") { Task { await assignAll() } }
        }
        .alert(notice ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) { Button("OK") {} }
        .task(id: model.repoId + "|" + model.state) { await model.load(api: api) }
        .refreshable { await model.load(api: api) }
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

private struct IssueSelection: Identifiable { let issue: IssueRow; var id: String { issue.identity } }

struct IssueRowView: View {
    let issue: IssueRow

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .top) {
                Text(issue.title).font(.body.weight(.medium)).lineLimit(2)
                Spacer(minLength: 8)
                if let t = issue.optioTask {
                    StatusBadge(text: t.state == "completed" ? "done" : t.state == "pr_opened" ? "PR" : (t.state ?? "assigned"), color: StateColor.color(for: t.state ?? ""))
                } else if !issue.isAssignable {
                    StatusBadge(text: "auto-sync", color: .secondary)
                }
            }
            HStack(spacing: 8) {
                Text(issue.numberText).monospacedDigit()
                Text(issue.repo?.fullName ?? issue.source ?? "").lineLimit(1)
                if let a = issue.author { Text("@\(a)") }
                if let u = issue.updatedAt { Text(u.relativeDescription) }
            }
            .font(.caption).foregroundStyle(.secondary)
            if let labels = issue.labels, !labels.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(labels, id: \.self) { l in
                            Text(l).font(.caption2).padding(.horizontal, 6).padding(.vertical, 2)
                                .background(l == "optio" ? AppTheme.accent.opacity(0.15) : Color(.tertiarySystemFill), in: Capsule())
                                .foregroundStyle(l == "optio" ? AppTheme.accent : .secondary)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// Tapping an issue: read it, open on the git host, or create a Task from it
/// (what the web's "Assign to Optio" does).
struct IssueDetailSheet: View {
    let issue: IssueRow
    var onAssigned: (String?) -> Void
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var agentType = ""
    @State private var assigning = false
    @State private var error: Error?
    @State private var createdTaskId: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(issue.title).font(.headline)
                    HStack(spacing: 8) {
                        Text(issue.numberText)
                        Text(issue.repo?.fullName ?? issue.source ?? "")
                        if let s = issue.state { StatusBadge(text: s, color: s == "open" ? .green : .gray) }
                    }.font(.caption).foregroundStyle(.secondary)
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
                    if let error { ErrorBanner(error: error) }
                }
            }
            .navigationTitle("Issue")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { id in TaskDetailView(taskId: id) }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
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
