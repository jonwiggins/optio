import SwiftUI

/// Interactive Sessions list — mirrors `apps/web/src/app/sessions/page.tsx`.
struct SessionsListView: View {
    @Environment(APIClient.self) private var api
    @State private var sessions: [InteractiveSession] = []
    @State private var activeCount = 0
    @State private var stats: SessionStats?
    @State private var repos: [SessionRepoOption] = []
    @State private var filter: String? = nil
    @State private var repoFilter: String? = nil
    @State private var error: Error?
    @State private var loaded = false
    @State private var showNew = false

    var body: some View {
        List {
            Section {
                VStack(spacing: 6) {
                    if let stats {
                        HStack(spacing: 8) {
                            StatTile(title: "Total", value: "\(stats.total)")
                            StatTile(title: "Active", value: "\(stats.active)", color: .blue)
                            StatTile(title: "Ended (24h)", value: "\(stats.ended)")
                        }
                        .padding(.horizontal)
                    }
                    ChipPicker(options: [(nil, "All"), ("active", "Active"), ("ended", "Ended")], selection: $filter)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
            if let error {
                ErrorBanner(error: error) { Task { await refresh() } }.listRowBackground(Color.clear)
            }
            if loaded && sessions.isEmpty {
                EmptyState(title: "No sessions yet", systemImage: "terminal", message: "Start a new session to get an interactive terminal connected to a repo pod.")
                    .listRowBackground(Color.clear)
            }
            ForEach(sessions, id: \.id) { s in
                NavigationLink(value: s.id) { SessionRow(session: s) }
            }
        }
        .listStyle(.plain)
        .overlay { if !loaded && error == nil { ProgressView() } }
        .navigationDestination(for: String.self) { id in SessionDetailView(sessionId: id) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showNew = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New session")
            }
            if repos.count > 1 {
                ToolbarItem(placement: .secondaryAction) {
                    Picker("Repo", selection: $repoFilter) {
                        Text("All repos").tag(String?.none)
                        ForEach(repos) { r in Text(r.displayName).tag(String?.some(r.repoUrl)) }
                    }
                }
            }
        }
        .sheet(isPresented: $showNew) {
            NewSessionSheet(repos: repos) { _ in Task { await refresh() } }
        }
        .onChange(of: filter) { _, _ in Task { await refresh() } }
        .onChange(of: repoFilter) { _, _ in Task { await refresh() } }
        .refreshable { await refresh() }
        .task {
            repos = (try? await api.listSessionRepos()) ?? []
            await refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                await refresh()
            }
        }
    }

    private func refresh() async {
        do {
            async let list = api.listSessions(state: filter, repoUrl: repoFilter)
            async let st = api.liveSessionStats()
            let r = try await list
            sessions = r.sessions
            activeCount = r.activeCount
            stats = try? await st
            error = nil
        } catch {
            self.error = error
        }
        loaded = true
    }
}

struct SessionRow: View {
    let session: InteractiveSession

    private var isActive: Bool { session.state == .active }
    private var repoName: String { session.repoUrl.replacingOccurrences(of: "https://github.com/", with: "") }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "terminal")
                .foregroundStyle(isActive ? AppTheme.accent : .secondary)
                .frame(width: 32, height: 32)
                .background((isActive ? AppTheme.accent : Color.secondary).opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(session.branch.isEmpty ? "Session \(session.id.prefix(8))" : session.branch)
                        .font(.subheadline.weight(.semibold)).lineLimit(1)
                    StatusBadge(text: session.state.rawValue, color: StateColor.color(for: session.state.rawValue))
                }
                HStack(spacing: 10) {
                    Label(repoName, systemImage: "folder").lineLimit(1)
                    Text("Started \(session.createdAt.relativeDescription)")
                    if let c = session.costUsd, let d = Double(c), d > 0 { Text(String(format: "$%.4f", d)).monospacedDigit() }
                }
                .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }
}

struct NewSessionSheet: View {
    let repos: [SessionRepoOption]
    var onCreated: (InteractiveSession) -> Void
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var repoUrl = ""
    @State private var creating = false
    @State private var error: Error?

    var body: some View {
        NavigationStack {
            Form {
                if repos.isEmpty {
                    Text("Add a repo first (Admin → Repos in the web UI).").foregroundStyle(.secondary)
                } else {
                    Picker("Repository", selection: $repoUrl) {
                        ForEach(repos) { r in Text(r.displayName).tag(r.repoUrl) }
                    }
                    .pickerStyle(.inline)
                }
                if let error { ErrorBanner(error: error) }
            }
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(creating ? "Creating…" : "Create") { Task { await create() } }
                        .disabled(creating || repoUrl.isEmpty)
                }
            }
            .onAppear { if repoUrl.isEmpty { repoUrl = repos.first?.repoUrl ?? "" } }
        }
    }

    private func create() async {
        creating = true
        defer { creating = false }
        do {
            let s = try await api.createSession(repoUrl: repoUrl)
            onCreated(s)
            dismiss()
        } catch {
            self.error = error
        }
    }
}
