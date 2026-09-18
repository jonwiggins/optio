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
    @State private var loading = false
    @State private var showNew = false

    var body: some View {
        List {
            Section {
                if let stats {
                    StatStrip(items: [
                        StatItem("Active", stats.active, key: "active"),
                        StatItem("Ended today", stats.ended, key: "ended"),
                        StatItem("Total", stats.total, key: "total"),
                    ], selected: filter) { item in
                        guard item.key != "total" else { withAnimation(.snappy) { filter = nil }; return }
                        withAnimation(.snappy) { filter = filter == item.key ? nil : item.key }
                    }
                } else if !loaded {
                    SkeletonStrip(labels: ["Active", "Ended today", "Total"])
                }
            }
            .listRowInsets(EdgeInsets(top: Spacing.xs, leading: Spacing.l, bottom: Spacing.xs, trailing: Spacing.l))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)

            Section {
                ChipPicker(options: [(nil, "All"), ("active", "Active"), ("ended", "Ended")], selection: $filter)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if let error {
                ErrorRow(error: error, what: "sessions") { Task { await refresh() } }
            }
            if !loaded && error == nil {
                SkeletonRows()
            } else if loaded && sessions.isEmpty {
                EmptyState(
                    title: filter == nil ? "No sessions yet" : "No \(filter!) sessions",
                    systemImage: "terminal",
                    message: filter == nil ? "An interactive terminal connected to a repo pod." : "Nothing matches this filter.",
                    actionTitle: filter == nil ? "New session" : nil,
                    action: { showNew = true }
                )
                .listRowSeparator(.hidden)
            }
            ForEach(sessions, id: \.id) { s in
                NavigationLink(value: s.id) { SessionRow(session: s) }
            }
        }
        .listStyle(.plain)
        .dimmedWhileLoading(loading && loaded)
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
        loading = true
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
        loading = false
        loaded = true
    }
}

/// `dot · branch · owner/repo · started 2h · $0.78`, trailing Ended when done.
struct SessionRow: View {
    let session: InteractiveSession

    private var repoName: String { session.repoUrl.replacingOccurrences(of: "https://github.com/", with: "") }

    var body: some View {
        OptioRow(
            title: session.branch.isEmpty ? "Session \(session.id.prefix(8))" : session.branch,
            tone: Tone.forState(session.state.rawValue),
            meta: Text.meta([
                Text(repoName),
                Text("started \(session.createdAt.relativeDescription)"),
                Cost.formatIfNonZero(session.costUsd).map { Text($0) },
            ]),
            trailing: session.state == .active ? nil : session.state.rawValue.capitalized
        )
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
                    Text("Add a repo first under More › Repos.").foregroundStyle(.secondary)
                } else {
                    Picker("Repository", selection: $repoUrl) {
                        ForEach(repos) { r in Text(r.displayName).tag(r.repoUrl) }
                    }
                    .pickerStyle(.inline)
                }
                if let error { ErrorRow(error: error) }
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
