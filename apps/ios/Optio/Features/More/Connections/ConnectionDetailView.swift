import SwiftUI
import Observation

@Observable
@MainActor
final class ConnectionDetailModel {
    let connectionId: String
    var connection: ConnectionRow?
    var assignments: [ConnectionAssignmentRow] = []
    var error: Error?

    init(connectionId: String) { self.connectionId = connectionId }

    func load(api: APIClient) async {
        do {
            connection = try await api.getConnection(connectionId)
            error = nil
        } catch {
            self.error = error
            return
        }
        if let inline = connection?.assignments {
            assignments = inline
        } else {
            assignments = (try? await api.listConnectionAssignments(connectionId)) ?? []
        }
    }
}

/// One connection: status, test, enable/disable, assignments, delete.
/// Config values are never displayed — the API row's `config` is not decoded.
struct ConnectionDetailView: View {
    @Environment(APIClient.self) private var api
    @Environment(MoreContext.self) private var context
    @Environment(\.dismiss) private var dismiss
    @State private var model: ConnectionDetailModel
    let repos: [RepoRow]
    var onChanged: () async -> Void

    @State private var busy = false
    @State private var showDeleteConfirm = false
    @State private var showAddAssignment = false
    @State private var pendingAssignmentDelete: ConnectionAssignmentRow?
    @State private var testResult: String?
    @State private var errorMessage: String?

    init(connectionId: String, repos: [RepoRow], onChanged: @escaping () async -> Void) {
        _model = State(initialValue: ConnectionDetailModel(connectionId: connectionId))
        self.repos = repos
        self.onChanged = onChanged
    }

    var body: some View {
        Group {
            if let conn = model.connection {
                content(conn)
            } else if let error = model.error {
                ErrorBanner(error: error) { Task { await model.load(api: api) } }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(model.connection?.name ?? "Connection")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load(api: api) }
        .refreshable { await model.load(api: api) }
        .alert("Connection test", isPresented: Binding(get: { testResult != nil }, set: { if !$0 { testResult = nil } })) {
            Button("OK") { testResult = nil }
        } message: { Text(testResult ?? "") }
        .moreErrorAlert($errorMessage)
    }

    private func content(_ conn: ConnectionRow) -> some View {
        List {
            Section {
                HStack {
                    Circle().fill(ConnectionIcons.statusColor(conn.status)).frame(width: 10, height: 10)
                    Text(conn.status?.capitalized ?? "Unknown")
                    Spacer()
                    if let at = conn.lastCheckedAt {
                        Text("checked \(at.relativeDescription)").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let msg = conn.statusMessage, !msg.isEmpty {
                    Text(msg).font(.footnote).foregroundStyle(.secondary)
                }
                if let p = conn.provider {
                    MoreInfoRow(label: "Provider", value: p.name ?? p.slug ?? "")
                    if let t = p.type { MoreInfoRow(label: "Type", value: t.uppercased()) }
                }
                MoreInfoRow(label: "Scope", value: conn.scope == "global" || conn.scope == nil ? "Global" : (conn.repoUrl ?? conn.scope ?? ""))
                MoreInfoRow(label: "Enabled", value: conn.enabled == false ? "No" : "Yes")
                if let c = conn.createdAt { MoreInfoRow(label: "Created", value: c.relativeDescription) }
            } footer: {
                Text("Configuration values (tokens, URLs) are write-only and never shown here.")
            }

            if let caps = conn.provider?.capabilities, !caps.isEmpty {
                Section("Capabilities") { MoreChipCloud(items: caps) }
            }

            Section {
                if model.assignments.isEmpty {
                    Text("No assignments — this connection is not injected anywhere.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(model.assignments) { a in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(repoLabel(a.repoId)).font(.subheadline)
                            Spacer()
                            StatusBadge(text: a.permission ?? "read", color: AppTheme.accent)
                            if a.enabled == false { StatusBadge(text: "off", color: .orange) }
                        }
                        let agents = a.agentTypes ?? []
                        Text(agents.isEmpty ? "All agents" : agents.map(MoreAgentTypes.label).joined(separator: ", "))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .swipeActions(edge: .trailing) {
                        if context.isMember {
                            Button(role: .destructive) { pendingAssignmentDelete = a } label: { Label("Remove", systemImage: "trash") }
                        }
                    }
                }
                if context.isMember {
                    Button { showAddAssignment = true } label: { Label("Add assignment", systemImage: "plus") }
                }
            } header: {
                Text("Assignments")
            } footer: {
                Text("Which repos and agent types receive this connection, and with what permission.")
            }

            if context.isAdmin {
                Section {
                    Button { Task { await test() } } label: {
                        if busy { ProgressView() } else { Label("Test connection", systemImage: "bolt") }
                    }
                    .disabled(busy)
                    Button {
                        Task { await setEnabled(!(conn.enabled ?? true)) }
                    } label: {
                        Label(conn.enabled == false ? "Enable" : "Disable", systemImage: conn.enabled == false ? "play" : "pause")
                    }
                    .disabled(busy)
                    Button(role: .destructive) { showDeleteConfirm = true } label: {
                        Label("Delete connection", systemImage: "trash")
                    }
                    .disabled(busy)
                }
            }
        }
        .sheet(isPresented: $showAddAssignment) {
            NewAssignmentSheet(connectionId: conn.id, repos: repos) { await model.load(api: api) }
        }
        .confirmationDialog("Delete \"\(conn.name ?? "connection")\"?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await deleteConnection() } }
        } message: { Text("Assignments are removed too. This cannot be undone.") }
        .confirmationDialog("Remove this assignment?", isPresented: Binding(
            get: { pendingAssignmentDelete != nil }, set: { if !$0 { pendingAssignmentDelete = nil } }
        ), titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                guard let a = pendingAssignmentDelete else { return }
                Task {
                    do { try await api.deleteConnectionAssignment(a.id); await model.load(api: api) }
                    catch { errorMessage = error.moreDescription }
                }
            }
        }
    }

    private func repoLabel(_ repoId: String?) -> String {
        guard let repoId else { return "All repos" }
        return repos.first { $0.id == repoId }?.displayName ?? "Repo \(repoId.prefix(8))"
    }

    private func test() async {
        busy = true
        defer { busy = false }
        do {
            let c = try await api.testConnection(model.connectionId)
            let ok = c.status == "healthy" || c.status == "connected"
            testResult = (ok ? "Healthy" : "Failed") + (c.statusMessage.map { ": \($0)" } ?? "")
            await model.load(api: api)
            await onChanged()
        } catch {
            errorMessage = error.moreDescription
        }
    }

    private func setEnabled(_ on: Bool) async {
        busy = true
        defer { busy = false }
        do {
            try await api.setConnectionEnabled(model.connectionId, enabled: on)
            await model.load(api: api)
            await onChanged()
        } catch {
            errorMessage = error.moreDescription
        }
    }

    private func deleteConnection() async {
        busy = true
        defer { busy = false }
        do {
            try await api.deleteConnection(model.connectionId)
            await onChanged()
            dismiss()
        } catch {
            errorMessage = error.moreDescription
        }
    }
}

/// Reusable access-control picker: repo (or all), agent types (or all), permission.
struct AccessControlFields: View {
    let repos: [RepoRow]
    @Binding var repoId: String
    @Binding var agentTypes: Set<String>
    @Binding var permission: String

    var body: some View {
        Picker("Permission", selection: $permission) {
            Text("Read only").tag("read")
            Text("Read & write").tag("readwrite")
            Text("Full access").tag("full")
        }
        Picker("Repo", selection: $repoId) {
            Text("All repos").tag("")
            ForEach(repos) { Text($0.displayName).tag($0.id) }
        }
        ForEach(MoreAgentTypes.all, id: \.0) { agent in
            Toggle(agent.1, isOn: Binding(
                get: { agentTypes.contains(agent.0) },
                set: { on in if on { agentTypes.insert(agent.0) } else { agentTypes.remove(agent.0) } }
            ))
        }
    }
}

struct NewAssignmentSheet: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    let connectionId: String
    let repos: [RepoRow]
    var onSaved: () async -> Void

    @State private var repoId = ""
    @State private var agentTypes: Set<String> = []
    @State private var permission = "read"
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    AccessControlFields(repos: repos, repoId: $repoId, agentTypes: $agentTypes, permission: $permission)
                } footer: {
                    Text("Leave all agent toggles off to allow every agent type.")
                }
            }
            .navigationTitle("New Assignment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        if saving { ProgressView() } else { Text("Add") }
                    }
                    .disabled(saving)
                }
            }
            .moreErrorAlert($errorMessage)
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            try await api.createConnectionAssignment(connectionId, ConnectionAssignmentInput(
                repoId: repoId.isEmpty ? nil : repoId,
                agentTypes: MoreAgentTypes.all.map(\.0).filter { agentTypes.contains($0) },
                permission: permission
            ))
            await onSaved()
            dismiss()
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
