import SwiftUI
import Observation

@Observable
@MainActor
final class RepoDetailModel {
    let repoId: String
    var repo: RepoRow?
    var connections: [ConnectionRow] = []
    var mcpServers: [McpServerRow] = []
    var directories: [SharedDirectoryRow] = []
    var error: Error?

    init(repoId: String) { self.repoId = repoId }

    func load(api: APIClient) async {
        do {
            repo = try await api.getRepo(repoId)
            error = nil
        } catch {
            self.error = error
            return
        }
        async let conns = api.listRepoConnections(repoId: repoId)
        async let servers = api.listRepoMcpServers(repoId: repoId)
        async let dirs = api.listSharedDirectories(repoId: repoId)
        connections = (try? await conns) ?? []
        mcpServers = (try? await servers) ?? []
        directories = (try? await dirs) ?? []
    }
}

struct RepoDetailView: View {
    @Environment(APIClient.self) private var api
    @Environment(MoreContext.self) private var context
    @Environment(\.dismiss) private var dismiss
    @State private var model: RepoDetailModel
    var onChanged: () async -> Void

    @State private var showRecycleConfirm = false
    @State private var showDeleteConfirm = false
    @State private var showAddMcp = false
    @State private var pendingMcpDelete: McpServerRow?
    @State private var busy = false
    @State private var notice: String?
    @State private var errorMessage: String?

    init(repoId: String, onChanged: @escaping () async -> Void) {
        _model = State(initialValue: RepoDetailModel(repoId: repoId))
        self.onChanged = onChanged
    }

    var body: some View {
        Group {
            if let repo = model.repo {
                content(repo)
            } else if let error = model.error {
                ErrorBanner(error: error) { Task { await model.load(api: api) } }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(model.repo?.displayName ?? "Repository")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load(api: api) }
        .refreshable { await model.load(api: api) }
        .moreErrorAlert($errorMessage)
        .alert("Done", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK") { notice = nil }
        } message: {
            Text(notice ?? "")
        }
    }

    private func content(_ repo: RepoRow) -> some View {
        List {
            Section {
                if let url = repo.repoUrl {
                    MoreInfoRow(label: "URL", value: url, mono: true)
                }
                MoreInfoRow(label: "Branch", value: repo.defaultBranch ?? "main")
                MoreInfoRow(label: "Visibility", value: repo.isPrivate == true ? "Private" : "Public")
                MoreInfoRow(label: "Platform", value: repo.gitPlatform ?? "github")
                MoreInfoRow(label: "Image", value: repo.imagePreset ?? "base")
            }

            Section("Agent") {
                MoreInfoRow(label: "Default agent", value: MoreAgentTypes.label(repo.defaultAgentType ?? "claude-code"))
                if repo.defaultAgentType ?? "claude-code" == "claude-code" {
                    MoreInfoRow(label: "Model", value: "\(repo.claudeModel ?? "opus") · \(repo.claudeContextWindow ?? "1m") · \(repo.claudeEffort ?? "high")")
                }
                MoreInfoRow(label: "Max turns", value: String(repo.maxTurnsCoding ?? 250))
            }

            Section("PR lifecycle") {
                toggleRow("Code review", repo.reviewEnabled == true)
                if repo.reviewEnabled == true {
                    MoreInfoRow(label: "Trigger", value: reviewTriggerLabel(repo.reviewTrigger))
                    MoreInfoRow(label: "Reviewer", value: reviewerLabel(repo))
                }
                toggleRow("Auto-resume", repo.autoResume == true)
                toggleRow("Auto-merge", repo.autoMerge == true)
                toggleRow("Cautious mode", repo.cautiousMode == true)
                toggleRow("Planning mode", repo.planningModeEnabled == true)
            }

            Section("Concurrency") {
                MoreInfoRow(label: "Max concurrent tasks", value: String(repo.maxConcurrentTasks ?? 2))
                MoreInfoRow(label: "Pod instances", value: String(repo.maxPodInstances ?? 1))
                MoreInfoRow(label: "Agents per pod", value: String(repo.maxAgentsPerPod ?? 2))
            }

            if context.isAdmin {
                Section {
                    NavigationLink {
                        RepoSettingsView(repo: repo) {
                            await model.load(api: api)
                            await onChanged()
                        }
                    } label: {
                        Label("Edit settings", systemImage: "slider.horizontal.3")
                    }
                }
            }

            Section {
                NavigationLink {
                    SharedDirectoriesView(repoId: repo.id, maxPodInstances: repo.maxPodInstances ?? 1)
                } label: {
                    HStack {
                        Label("Shared directories", systemImage: "externaldrive")
                        Spacer()
                        Text(String(model.directories.count)).foregroundStyle(.secondary)
                    }
                }
            } footer: {
                Text("Persistent per-repo caches (npm, pip, cargo…) mounted into agent pods.")
            }

            Section("Connections") {
                if model.connections.isEmpty {
                    Text("No connections assigned to this repo.").font(.footnote).foregroundStyle(.secondary)
                } else {
                    ForEach(model.connections) { conn in
                        HStack(spacing: 10) {
                            Circle().fill(StateColor.color(for: conn.status == "healthy" ? "success" : (conn.status == "error" ? "error" : "unknown")))
                                .frame(width: 8, height: 8)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(conn.name ?? conn.id).font(.subheadline)
                                if let p = conn.provider?.name {
                                    Text(p).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            StatusBadge(text: conn.enabled == false ? "disabled" : "active",
                                        color: conn.enabled == false ? .secondary : .green)
                        }
                    }
                }
            }

            Section {
                if model.mcpServers.isEmpty {
                    Text("No MCP servers apply to this repo.").font(.footnote).foregroundStyle(.secondary)
                } else {
                    ForEach(model.mcpServers) { s in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(s.name ?? s.id).font(.subheadline)
                                Spacer()
                                StatusBadge(text: s.scope == "global" ? "global" : "repo", color: .secondary)
                                if s.enabled == false { StatusBadge(text: "disabled", color: .orange) }
                            }
                            Text(([s.command ?? ""] + (s.args ?? [])).joined(separator: " "))
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        .swipeActions(edge: .trailing) {
                            if context.isAdmin && s.scope != "global" {
                                Button(role: .destructive) { pendingMcpDelete = s } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                        }
                    }
                }
                if context.isAdmin {
                    Button { showAddMcp = true } label: {
                        Label("Add repo MCP server", systemImage: "plus")
                    }
                }
            } header: {
                Text("MCP servers")
            } footer: {
                Text("Injected into the agent's .mcp.json at runtime. Use ${{SECRET_NAME}} to reference Optio secrets.")
            }

            if context.isAdmin {
                Section {
                    Button { showRecycleConfirm = true } label: {
                        Label("Recycle pods", systemImage: "arrow.clockwise")
                    }
                    .disabled(busy)
                    Button(role: .destructive) { showDeleteConfirm = true } label: {
                        Label("Remove repository", systemImage: "trash")
                    }
                    .disabled(busy)
                } footer: {
                    Text("Recycling destroys idle ready pods so they come back with fresh mounts and image settings.")
                }
            }
        }
        .sheet(isPresented: $showAddMcp) {
            McpServerSheet(repoId: repo.id) { await model.load(api: api) }
        }
        .confirmationDialog("Recycle idle pods for \(repo.displayName)?", isPresented: $showRecycleConfirm, titleVisibility: .visible) {
            Button("Recycle") { Task { await recycle() } }
        }
        .confirmationDialog("Remove \(repo.displayName) from Optio?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { Task { await deleteRepo() } }
        } message: {
            Text("Tasks and settings for this repo will be deleted.")
        }
        .confirmationDialog("Delete MCP server \"\(pendingMcpDelete?.name ?? "")\"?", isPresented: Binding(
            get: { pendingMcpDelete != nil }, set: { if !$0 { pendingMcpDelete = nil } }
        ), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                guard let s = pendingMcpDelete else { return }
                Task {
                    do {
                        try await api.deleteMcpServer(s.id)
                        await model.load(api: api)
                    } catch { errorMessage = error.moreDescription }
                }
            }
        }
    }

    private func toggleRow(_ label: String, _ on: Bool) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Image(systemName: on ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(on ? AnyShapeStyle(.green) : AnyShapeStyle(.tertiary))
        }
    }

    private func reviewTriggerLabel(_ raw: String?) -> String {
        switch raw {
        case "on_pr": return "Immediately on PR open"
        case "manual": return "Manual only"
        default: return "After CI passes"
        }
    }

    private func reviewerLabel(_ repo: RepoRow) -> String {
        let agent = repo.reviewAgentType ?? repo.effectiveReviewAgentType ?? repo.defaultAgentType ?? "claude-code"
        let model = repo.reviewModel ?? repo.effectiveReviewModel
        return model.map { "\(MoreAgentTypes.label(agent)) · \($0)" } ?? MoreAgentTypes.label(agent)
    }

    private func recycle() async {
        busy = true
        defer { busy = false }
        do {
            let n = try await api.recycleRepoPods(model.repoId)
            notice = n == 0 ? "No idle pods to recycle." : "Recycled \(n) pod\(n == 1 ? "" : "s")."
        } catch {
            errorMessage = error.moreDescription
        }
    }

    private func deleteRepo() async {
        busy = true
        defer { busy = false }
        do {
            try await api.deleteRepo(model.repoId)
            await onChanged()
            dismiss()
        } catch {
            errorMessage = error.moreDescription
        }
    }
}

/// Add an MCP server, either global or scoped to a repo.
struct McpServerSheet: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    var repoId: String? = nil
    var onSaved: () async -> Void

    @State private var name = ""
    @State private var command = ""
    @State private var args = ""
    @State private var env = ""
    @State private var installCommand = ""
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                    TextField("Command (e.g. npx)", text: $command)
                        .font(.body.monospaced())
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                }
                Section("Args (one per line)") {
                    TextEditor(text: $args).font(.footnote.monospaced()).frame(minHeight: 80)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                }
                Section {
                    TextEditor(text: $env).font(.footnote.monospaced()).frame(minHeight: 80)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                } header: {
                    Text("Env (KEY=value per line)")
                } footer: {
                    Text("Use ${{SECRET_NAME}} to reference an Optio secret.")
                }
                Section("Install command (optional)") {
                    TextField("npm install -g …", text: $installCommand)
                        .font(.body.monospaced())
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                }
            }
            .navigationTitle(repoId == nil ? "Global MCP Server" : "Repo MCP Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        if saving { ProgressView() } else { Text("Add") }
                    }
                    .disabled(saving || name.isEmpty || command.isEmpty)
                }
            }
            .moreErrorAlert($errorMessage)
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        var envMap: [String: String] = [:]
        for line in env.split(separator: "\n") {
            let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if parts.count == 2, !parts[0].isEmpty { envMap[parts[0]] = parts[1] }
        }
        let argList = args.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let input = McpServerInput(
            name: name.trimmingCharacters(in: .whitespaces),
            command: command.trimmingCharacters(in: .whitespaces),
            args: argList.isEmpty ? nil : argList,
            env: envMap.isEmpty ? nil : envMap,
            installCommand: installCommand.isEmpty ? nil : installCommand,
            repoUrl: nil
        )
        do {
            if let repoId {
                try await api.createRepoMcpServer(repoId: repoId, input)
            } else {
                try await api.createMcpServer(input)
            }
            await onSaved()
            dismiss()
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
