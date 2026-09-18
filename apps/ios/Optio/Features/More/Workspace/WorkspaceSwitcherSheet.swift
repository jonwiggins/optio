import SwiftUI

/// Pick the active workspace. Matches the web's switcher, which does both:
/// `POST /api/workspaces/:id/switch` (server-side default) AND stores the id
/// locally so every request carries `x-workspace-id`.
struct WorkspaceSwitcherSheet: View {
    @Environment(APIClient.self) private var api
    @Environment(SessionStore.self) private var session
    @Environment(MoreContext.self) private var context
    @Environment(\.dismiss) private var dismiss
    var onSwitched: () async -> Void

    @State private var workspaces: [WorkspaceRow] = []
    @State private var loading = true
    @State private var switching: String?
    @State private var showCreate = false
    @State private var errorMessage: String?

    private var currentId: String? { session.workspaceId ?? context.workspaceId }

    var body: some View {
        NavigationStack {
            List {
                if loading {
                    ProgressView().frame(maxWidth: .infinity)
                } else if workspaces.isEmpty {
                    EmptyState(title: "No workspaces", systemImage: "building.2")
                } else {
                    Section {
                        ForEach(workspaces) { ws in
                            Button {
                                Task { await switchTo(ws) }
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(ws.name ?? ws.slug ?? ws.id).foregroundStyle(.primary)
                                        HStack(spacing: 6) {
                                            if let s = ws.slug { Text(s).font(.caption.monospaced()) }
                                            if let r = ws.role { Text("· \(r)").font(.caption) }
                                        }
                                        .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if switching == ws.id {
                                        ProgressView()
                                    } else if ws.id == currentId {
                                        Image(systemName: "checkmark").foregroundStyle(AppTheme.accent)
                                    }
                                }
                            }
                            .disabled(switching != nil)
                        }
                    }
                }
                Section {
                    Button { showCreate = true } label: { Label("New workspace", systemImage: "plus") }
                }
            }
            .navigationTitle("Switch Workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
            .task { await load() }
            .sheet(isPresented: $showCreate) {
                CreateWorkspaceSheet { ws in
                    await load()
                    await switchTo(ws)
                }
            }
            .moreErrorAlert($errorMessage)
        }
    }

    private func load() async {
        do {
            workspaces = try await api.listWorkspaces()
        } catch {
            errorMessage = error.moreDescription
        }
        loading = false
    }

    private func switchTo(_ ws: WorkspaceRow) async {
        switching = ws.id
        defer { switching = nil }
        do {
            try await api.switchWorkspace(ws.id)
        } catch {
            errorMessage = error.moreDescription
            return
        }
        session.workspaceId = ws.id
        await session.refreshUser()
        await onSwitched()
        dismiss()
    }
}
