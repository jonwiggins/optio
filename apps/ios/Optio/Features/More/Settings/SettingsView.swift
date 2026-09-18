import SwiftUI

/// Settings hub: Optio assistant settings, Claude auth status, authentication
/// providers, personal access tokens, notification preferences, and the app
/// section (server, version, sign out).
struct SettingsView: View {
    @Environment(APIClient.self) private var api
    @Environment(SessionStore.self) private var session
    @Environment(MoreContext.self) private var context
    @AppStorage(AppAppearance.storageKey) private var appearance: AppAppearance = .system

    @State private var claude: ClaudeAuthStatus.Subscription?
    @State private var claudeError: String?
    @State private var refreshing = false
    @State private var providers: [AuthProviderInfo] = []
    @State private var authDisabled = false
    @State private var showSignOutConfirm = false
    @State private var errorMessage: String?

    private var appVersion: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
        return "\(v) (\(b))"
    }

    var body: some View {
        List {
            Section("Optio") {
                NavigationLink { OptioAgentSettingsView() } label: {
                    Label("Optio agent settings", systemImage: "sparkles")
                }
                NavigationLink { ApiKeysView() } label: {
                    Label("Personal access tokens", systemImage: "key.horizontal")
                }
                NavigationLink { NotificationPreferencesView() } label: {
                    Label("Notifications", systemImage: "bell")
                }
                NavigationLink { NotificationsDevicesView() } label: {
                    Label("Notifications on this iPhone", systemImage: "iphone.radiowaves.left.and.right")
                }
            }

            Section {
                if let claude {
                    HStack {
                        Image(systemName: claude.expired == true ? "xmark.octagon.fill" : (claude.available == true ? "checkmark.seal.fill" : "questionmark.circle"))
                            .foregroundStyle(claude.expired == true ? .red : (claude.available == true ? .green : .secondary))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(claude.expired == true ? "Token expired" : (claude.available == true ? "Token available" : "No token configured"))
                            if let err = claude.error, !err.isEmpty {
                                Text(err).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if let exp = claude.expiresAt { MoreInfoRow(label: "Expires", value: exp.relativeDescription) }
                    if let v = claude.lastValidated { MoreInfoRow(label: "Last validated", value: v.relativeDescription) }
                } else if let claudeError {
                    Label(claudeError, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.red)
                } else {
                    ProgressView()
                }
                if context.isAdmin {
                    Button {
                        Task { await refreshClaude() }
                    } label: {
                        if refreshing { ProgressView() } else { Label("Refresh credential cache", systemImage: "arrow.clockwise") }
                    }
                    .disabled(refreshing)
                }
            } header: {
                Text("Claude authentication")
            } footer: {
                Text("Agents authenticate with CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY from Secrets. Paste a new value there when the token expires.")
            }

            Section {
                if authDisabled {
                    Label("Authentication is disabled on this server (OPTIO_AUTH_DISABLED).", systemImage: "shield.slash")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(["github", "google", "gitlab", "oidc"], id: \.self) { name in
                    let enabled = providers.contains { $0.name == name }
                    HStack {
                        Image(systemName: enabled ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(enabled ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary))
                        Text(providerLabel(name))
                        Spacer()
                        Text(enabled ? "Configured" : "Not configured").font(.caption).foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("Sign-in providers")
            } footer: {
                Text("OAuth providers are detected from <PROVIDER>_OAUTH_CLIENT_ID / _SECRET on the server.")
            }

            Section("App") {
                Picker(selection: $appearance) {
                    ForEach(AppAppearance.allCases) { a in
                        Text(a.label).tag(a)
                    }
                } label: {
                    Label("Appearance", systemImage: "circle.lefthalf.filled")
                }
                .pickerStyle(.segmented)
                NavigationLink { AppIconPickerView() } label: {
                    HStack {
                        Label("App icon", systemImage: "app.badge")
                        Spacer()
                        AppIconThumbnail(option: .current, size: 28)
                    }
                }
                MoreInfoRow(label: "Server", value: session.serverURL?.absoluteString ?? "—", mono: true)
                MoreInfoRow(label: "Version", value: appVersion)
                if let ws = context.workspaceId { MoreInfoRow(label: "Workspace", value: ws, mono: true) }
                Button(role: .destructive) { showSignOutConfirm = true } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        }
        .navigationTitle("Settings")
        .task { await load() }
        .refreshable { await load() }
        .confirmationDialog("Sign out of Optio?", isPresented: $showSignOutConfirm, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { session.signOut() }
        }
        .moreErrorAlert($errorMessage)
    }

    private func providerLabel(_ name: String) -> String {
        switch name {
        case "github": return "GitHub"
        case "google": return "Google"
        case "gitlab": return "GitLab"
        case "oidc": return "OpenID Connect"
        default: return name
        }
    }

    private func load() async {
        do {
            claude = try await api.claudeAuthStatus().subscription
            claudeError = nil
        } catch {
            claudeError = error.moreDescription
        }
        if let p = try? await api.listAuthProviders() {
            providers = p.providers
            authDisabled = p.authDisabled
        }
    }

    private func refreshClaude() async {
        refreshing = true
        defer { refreshing = false }
        do {
            try await api.refreshClaudeAuth()
            await load()
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
