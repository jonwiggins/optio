import SwiftUI
import Observation

@Observable
@MainActor
final class WorkspaceSettingsModel {
    var workspace: WorkspaceRow?
    var role: String?
    var members: [WorkspaceMemberRow] = []
    var loading = false
    var error: Error?

    var isAdmin: Bool { role == "admin" }

    func load(api: APIClient, workspaceId: String?) async {
        loading = workspace == nil
        defer { loading = false }
        var wsId = workspaceId
        if wsId == nil {
            wsId = (try? await api.listWorkspaces())?.first?.id
        }
        guard let wsId else {
            error = APIError(status: 0, message: "No workspace selected", body: nil)
            return
        }
        do {
            let detail = try await api.getWorkspace(wsId)
            workspace = detail.workspace
            role = detail.role
            error = nil
        } catch {
            self.error = error
            return
        }
        members = (try? await api.listWorkspaceMembers(wsId)) ?? []
    }
}

/// Mirrors /workspace-settings: general info (admin-editable), members with
/// roles, invite by email, and the delete danger zone.
struct WorkspaceSettingsView: View {
    @Environment(APIClient.self) private var api
    @Environment(SessionStore.self) private var session
    @Environment(MoreContext.self) private var context
    @Environment(\.dismiss) private var dismiss
    @State private var model = WorkspaceSettingsModel()

    @State private var name = ""
    @State private var slug = ""
    @State private var description = ""
    @State private var saving = false
    @State private var inviteEmail = ""
    @State private var inviteRole = "member"
    @State private var inviting = false
    @State private var pendingRemove: WorkspaceMemberRow?
    @State private var showDeleteConfirm = false
    @State private var showCreate = false
    @State private var notice: String?
    @State private var errorMessage: String?

    private var dirty: Bool {
        guard let ws = model.workspace else { return false }
        return name != (ws.name ?? "") || slug != (ws.slug ?? "") || description != (ws.description ?? "")
    }

    var body: some View {
        List {
            if model.loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if let error = model.error, model.workspace == nil {
                ErrorBanner(error: error) { Task { await load() } }
            } else if let ws = model.workspace {
                Section {
                    if model.isAdmin {
                        TextField("Name", text: $name)
                        TextField("Slug", text: $slug)
                            .autocorrectionDisabled().textInputAutocapitalization(.never)
                        TextField("Description", text: $description, axis: .vertical)
                        Button {
                            Task { await save(ws) }
                        } label: {
                            if saving { ProgressView() } else { Text("Save changes") }
                        }
                        .disabled(saving || !dirty || name.isEmpty || slug.isEmpty)
                    } else {
                        MoreInfoRow(label: "Name", value: ws.name ?? "")
                        MoreInfoRow(label: "Slug", value: ws.slug ?? "", mono: true)
                        if let d = ws.description, !d.isEmpty { Text(d).font(.footnote).foregroundStyle(.secondary) }
                    }
                    MoreInfoRow(label: "Your role", value: model.role ?? "member")
                } header: {
                    Text("General")
                } footer: {
                    Text(model.isAdmin ? "Slug: lowercase letters, numbers and hyphens." : "Only workspace admins can edit workspace settings.")
                }

                Section {
                    ForEach(model.members) { m in
                        memberRow(m)
                    }
                    if model.isAdmin {
                        HStack {
                            TextField("user@example.com", text: $inviteEmail)
                                .keyboardType(.emailAddress)
                                .autocorrectionDisabled().textInputAutocapitalization(.never)
                            Picker("", selection: $inviteRole) {
                                Text("Member").tag("member")
                                Text("Admin").tag("admin")
                                Text("Viewer").tag("viewer")
                            }
                            .labelsHidden()
                        }
                        Button {
                            Task { await invite(ws) }
                        } label: {
                            if inviting { ProgressView() } else { Label("Add member", systemImage: "person.badge.plus") }
                        }
                        .disabled(inviting || inviteEmail.isEmpty)
                    }
                } header: {
                    Text("Members (\(model.members.count))")
                } footer: {
                    if model.isAdmin { Text("The user must have signed in to Optio at least once to be found.") }
                }

                Section {
                    Button { showCreate = true } label: { Label("Create a new workspace", systemImage: "plus.square") }
                }

                if model.isAdmin {
                    Section {
                        Button(role: .destructive) { showDeleteConfirm = true } label: {
                            Label("Delete workspace", systemImage: "trash")
                        }
                    } footer: {
                        Text("Permanently deletes this workspace and all its data. This cannot be undone.")
                    }
                }
            }
        }
        .navigationTitle("Workspace")
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showCreate) {
            CreateWorkspaceSheet { _ in await load() }
        }
        .confirmationDialog("Remove \(pendingRemove?.displayName ?? "member") from this workspace?", isPresented: Binding(
            get: { pendingRemove != nil }, set: { if !$0 { pendingRemove = nil } }
        ), titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                guard let m = pendingRemove, let ws = model.workspace else { return }
                Task {
                    do { try await api.removeWorkspaceMember(ws.id, userId: m.userId); await load() }
                    catch { errorMessage = error.moreDescription }
                }
            }
        }
        .confirmationDialog("Delete this workspace?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Delete workspace", role: .destructive) { Task { await deleteWorkspace() } }
        } message: { Text("All repos, tasks, secrets and settings in it will be deleted.") }
        .alert("Workspace", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK") { notice = nil }
        } message: { Text(notice ?? "") }
        .moreErrorAlert($errorMessage)
    }

    private func memberRow(_ m: WorkspaceMemberRow) -> some View {
        HStack(spacing: 10) {
            Image(systemName: roleIcon(m.role)).foregroundStyle(m.role == "admin" ? AppTheme.accent : .secondary).frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(m.displayName ?? m.email ?? m.userId).font(.subheadline).lineLimit(1)
                if let e = m.email { Text(e).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer()
            if model.isAdmin {
                Picker("", selection: Binding(
                    get: { m.role ?? "member" },
                    set: { new in Task { await changeRole(m, new) } }
                )) {
                    Text("Admin").tag("admin")
                    Text("Member").tag("member")
                    Text("Viewer").tag("viewer")
                }
                .labelsHidden()
            } else {
                Text((m.role ?? "member").capitalized).font(.caption).foregroundStyle(.secondary)
            }
        }
        .swipeActions(edge: .trailing) {
            if model.isAdmin && model.members.count > 1 {
                Button(role: .destructive) { pendingRemove = m } label: { Label("Remove", systemImage: "person.badge.minus") }
            }
        }
    }

    private func roleIcon(_ role: String?) -> String {
        switch role {
        case "admin": return "shield.fill"
        case "viewer": return "eye"
        default: return "pencil"
        }
    }

    private func load() async {
        await model.load(api: api, workspaceId: context.workspaceId ?? session.workspaceId)
        if let ws = model.workspace {
            name = ws.name ?? ""
            slug = ws.slug ?? ""
            description = ws.description ?? ""
        }
    }

    private func save(_ ws: WorkspaceRow) async {
        saving = true
        defer { saving = false }
        do {
            _ = try await api.updateWorkspace(ws.id, name: name, slug: slug, description: description.isEmpty ? nil : description)
            await load()
            notice = "Workspace updated."
        } catch {
            errorMessage = error.moreDescription
        }
    }

    private func invite(_ ws: WorkspaceRow) async {
        inviting = true
        defer { inviting = false }
        do {
            let user = try await api.lookupUser(email: inviteEmail.trimmingCharacters(in: .whitespaces))
            try await api.addWorkspaceMember(ws.id, userId: user.id, role: inviteRole)
            inviteEmail = ""
            await load()
            notice = "\(user.displayName ?? user.email ?? "User") added to workspace."
        } catch {
            errorMessage = error.moreDescription
        }
    }

    private func changeRole(_ m: WorkspaceMemberRow, _ role: String) async {
        guard let ws = model.workspace, role != m.role else { return }
        do {
            try await api.updateWorkspaceMemberRole(ws.id, userId: m.userId, role: role)
            await load()
        } catch {
            errorMessage = error.moreDescription
        }
    }

    private func deleteWorkspace() async {
        guard let ws = model.workspace else { return }
        do {
            try await api.deleteWorkspace(ws.id)
            if session.workspaceId == ws.id { session.workspaceId = nil }
            await session.refreshUser()
            dismiss()
        } catch {
            errorMessage = error.moreDescription
        }
    }
}

struct CreateWorkspaceSheet: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    var onCreated: (WorkspaceRow) async -> Void

    @State private var name = ""
    @State private var slug = ""
    @State private var slugEdited = false
    @State private var description = ""
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .onChange(of: name) { _, n in if !slugEdited { slug = Self.slugify(n) } }
                    TextField("Slug", text: $slug)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                        .onChange(of: slug) { old, new in if new != Self.slugify(name) && new != old { slugEdited = true } }
                    TextField("Description (optional)", text: $description, axis: .vertical)
                } footer: {
                    Text("You become the admin of the new workspace.")
                }
            }
            .navigationTitle("New Workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        if saving { ProgressView() } else { Text("Create") }
                    }
                    .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty || slug.isEmpty)
                }
            }
            .moreErrorAlert($errorMessage)
        }
    }

    static func slugify(_ s: String) -> String {
        let lowered = s.lowercased()
        var out = ""
        var lastDash = true
        for ch in lowered {
            if ch.isLetter || ch.isNumber, ch.isASCII {
                out.append(ch); lastDash = false
            } else if !lastDash {
                out.append("-"); lastDash = true
            }
        }
        while out.hasSuffix("-") { out.removeLast() }
        return out
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            let ws = try await api.createWorkspace(name: name.trimmingCharacters(in: .whitespaces), slug: slug, description: description.isEmpty ? nil : description)
            await onCreated(ws)
            dismiss()
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
