import SwiftUI

/// The "More" tab: the web sidebar's Library + Admin groups plus Settings and
/// the account card. Each row pushes its own screen; creation flows are sheets.
struct MoreHubView: View {
    @Environment(APIClient.self) private var api
    @Environment(SessionStore.self) private var session
    @State private var context = MoreContext()
    @State private var showWorkspaceSwitcher = false
    @State private var showSignOutConfirm = false
    @State private var currentWorkspaceName: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink { PromptsListView() } label: {
                        Label("Prompts", systemImage: "text.quote")
                    }
                    NavigationLink { ReposListView() } label: {
                        Label("Repos", systemImage: "folder")
                    }
                    NavigationLink { ConnectionsView() } label: {
                        Label("Connections", systemImage: "powerplug")
                    }
                } header: {
                    SectionHeader(title: "Library").textCase(nil)
                }

                Section {
                    NavigationLink { SecretsView() } label: {
                        Label("Secrets", systemImage: "key")
                    }
                    NavigationLink { WebhooksListView() } label: {
                        Label("Webhooks", systemImage: "arrow.up.right.square")
                    }
                    NavigationLink { WorkspaceSettingsView() } label: {
                        Label("Workspace", systemImage: "building.2")
                    }
                    NavigationLink { SettingsView() } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                } header: {
                    SectionHeader(title: "Admin").textCase(nil)
                }

                Section {
                    accountCard
                    Button {
                        showWorkspaceSwitcher = true
                    } label: {
                        HStack {
                            Label("Workspace", systemImage: "arrow.left.arrow.right")
                            Spacer()
                            Text(currentWorkspaceName ?? "Default")
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    .foregroundStyle(.primary)
                    Button(role: .destructive) {
                        showSignOutConfirm = true
                    } label: {
                        Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                } header: {
                    SectionHeader(title: "Account").textCase(nil)
                }
            }
            .symbolRenderingMode(.hierarchical)
            .navigationTitle("More")
            .hubChrome()
            .environment(context)
            .task { await refresh() }
            .refreshable { await refresh() }
            .sheet(isPresented: $showWorkspaceSwitcher) {
                WorkspaceSwitcherSheet { await refresh() }
                    .environment(context)
            }
            .confirmationDialog("Sign out of Optio?", isPresented: $showSignOutConfirm, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { session.signOut() }
            } message: {
                Text("Your access token will be removed from this device.")
            }
        }
        // On the stack itself, not the List: pushed destinations (Settings, Repos, …)
        // inherit the stack's environment, not the List's. Missing it crashes on push.
        .environment(context)
    }

    private var accountCard: some View {
        HStack(spacing: 12) {
            avatar
            VStack(alignment: .leading, spacing: 2) {
                Text(context.displayName ?? session.user?.displayName ?? "Signed in")
                    .font(.body)
                if let email = context.email ?? session.user?.email {
                    Text(email).font(.footnote).foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    if let role = context.role {
                        StatusBadge(text: role, tone: .working)
                    }
                    if let host = session.serverURL?.host() {
                        Text(host).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var avatar: some View {
        if let raw = session.user?.avatarUrl, let url = URL(string: raw) {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Circle().fill(.fill.tertiary)
            }
            .frame(width: 44, height: 44)
            .clipShape(Circle())
        } else {
            Image(systemName: "person.crop.circle.fill")
                .resizable()
                .frame(width: 44, height: 44)
                .foregroundStyle(.secondary)
        }
    }

    private func refresh() async {
        await context.refresh(api: api, session: session)
        if let wsId = context.workspaceId, let ws = try? await api.getWorkspace(wsId) {
            currentWorkspaceName = ws.workspace.name
        } else if let first = try? await api.listWorkspaces().first {
            currentWorkspaceName = first.name
        }
    }
}
