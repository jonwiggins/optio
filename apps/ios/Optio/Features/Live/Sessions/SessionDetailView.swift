import SwiftUI

/// Session detail — header, then Chat · Terminal · PRs chips. Both the chat and
/// terminal sockets stay open while the screen is visible so switching chips
/// doesn't reset either. Mirrors `apps/web/src/app/sessions/[id]/page.tsx`.
struct SessionDetailView: View {
    let sessionId: String
    @Environment(APIClient.self) private var api
    @State private var session: InteractiveSession?
    @State private var modelConfig: SessionModelConfig?
    @State private var prs: [SessionPr] = []
    @State private var error: Error?
    @State private var actionError: Error?
    @State private var chat: SessionChatModel?
    @State private var terminal: SessionTerminalController?
    @State private var section: Section = .chat
    @State private var confirmEnd = false
    @State private var ending = false

    enum Section: Hashable { case chat, terminal, prs }

    private var isActive: Bool { session?.state == .active }

    var body: some View {
        VStack(spacing: 0) {
            if let session {
                header(session)
                if isActive {
                    DetailTabs(options: [(Section.chat, "Chat"), (Section.terminal, "Terminal"), (Section.prs, prs.isEmpty ? "PRs" : "PRs (\(prs.count))")], selection: $section)
                }
                if let actionError { ErrorRow(error: actionError) }
                if isActive, let chat, let terminal {
                    switch section {
                    case .chat: SessionChatView(chat: chat, modelConfig: modelConfig)
                    case .terminal: SessionTerminalView(controller: terminal)
                    case .prs: prList
                    }
                } else if !isActive {
                    endedBody(session)
                } else {
                    ProgressView()
                }
            } else if let error {
                List { ErrorRow(error: error, what: "session") { Task { await load() } } }.listStyle(.plain)
            } else {
                List { SkeletonRows() }.listStyle(.plain)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if isActive {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        if let s = session, let url = URL(string: s.repoUrl) { Link(destination: url) { Label("Open repo", systemImage: "safari") } }
                        Divider()
                        Button(role: .destructive) { confirmEnd = true } label: { Label("End session", systemImage: "stop.circle") }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
        }
        .confirmationDialog("End this session?", isPresented: $confirmEnd, titleVisibility: .visible) {
            Button("End session", role: .destructive) { Task { await end() } }
        } message: {
            Text("The worktree will be cleaned up. Any un-pushed commits or changes will be lost.")
        }
        .task(id: sessionId) {
            if chat == nil { chat = SessionChatModel(sessionId: sessionId, api: api) }
            if terminal == nil { terminal = SessionTerminalController(sessionId: sessionId, api: api) }
            await load()
            if isActive { await chat?.start() }
            // PRs poll (web: 30s) while active.
            while !Task.isCancelled, isActive {
                try? await Task.sleep(for: .seconds(30))
                prs = (try? await api.listSessionPrs(sessionId)) ?? prs
            }
        }
        .onDisappear {
            chat?.stop()
            terminal?.stop()
        }
    }

    private var title: String {
        guard let s = session else { return "Session" }
        return s.branch.isEmpty ? "Session \(s.id.prefix(8))" : s.branch
    }

    private var displayCost: Double {
        let live = chat?.costUsd ?? 0
        if live > 0 { return live }
        return session?.costUsd.flatMap(Double.init) ?? 0
    }

    private func header(_ s: InteractiveSession) -> some View {
        let chatState: String? = {
            guard let chat, isActive else { return nil }
            if chat.isThinking { return "thinking" }
            return chat.canSend ? nil : chat.status.rawValue
        }()
        return DetailHeader(
            state: s.state.rawValue,
            line: Text.meta([
                Text(s.repoUrl.replacingOccurrences(of: "https://github.com/", with: "")),
                Text("started \(s.createdAt.relativeDescription)"),
                Cost.formatIfNonZero(displayCost).map { Text($0) },
                prs.isEmpty ? nil : Text("\(prs.count) PR\(prs.count == 1 ? "" : "s")"),
                chatState.map { Text($0) },
            ]),
            secondary: s.branch.isEmpty ? nil : Text.mono(s.branch),
            showsUsage: true
        )
    }

    private func endedBody(_ s: InteractiveSession) -> some View {
        VStack(spacing: 8) {
            EmptyState(title: "Session ended", systemImage: "terminal", message: s.endedAt.map { "Ended \($0.relativeDescription)" })
            if displayCost > 0 { Text("Cost \(Cost.format(displayCost))").font(.footnote).foregroundStyle(.secondary) }
            if !prs.isEmpty { prList.frame(maxHeight: 240) }
        }
    }

    private var prList: some View {
        List {
            if prs.isEmpty {
                Text("No PRs opened during this session yet. PR URLs printed in the terminal are picked up automatically.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(prs, id: \.id) { pr in
                Link(destination: URL(string: pr.prUrl) ?? URL(string: "https://github.com")!) {
                    OptioRow(
                        title: "PR #\(Int(pr.prNumber))",
                        tone: Tone.forState(pr.prState ?? "open") == .working ? nil : Tone.forState(pr.prState ?? "open"),
                        meta: Text.meta([pr.prState, pr.prChecksStatus.map { "CI \($0)" }, pr.prReviewStatus.map { "review \($0)" }]),
                        trailing: "Open ↗",
                        titleLineLimit: 1
                    )
                }
            }
        }
        .listStyle(.plain)
        .refreshable { prs = (try? await api.listSessionPrs(sessionId)) ?? prs }
    }

    private func load() async {
        do {
            let r = try await api.getSession(sessionId)
            session = r.session
            modelConfig = r.modelConfig
            prs = (try? await api.listSessionPrs(sessionId)) ?? []
            error = nil
        } catch {
            self.error = error
        }
    }

    private func end() async {
        ending = true
        defer { ending = false }
        do {
            session = try await api.endSession(sessionId)
            chat?.stop()
            terminal?.stop()
            actionError = nil
        } catch {
            actionError = error
        }
    }
}

/// Transcript + composer for the session's agent chat.
struct SessionChatView: View {
    @Bindable var chat: SessionChatModel
    let modelConfig: SessionModelConfig?

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if chat.rows.isEmpty {
                            Text("Send a message to start driving the agent in this session's worktree.")
                                .font(.footnote).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .padding(.top, 24)
                        }
                        ForEach(chat.rows, id: \.id) { row in
                            switch row {
                            case .user(_, let text):
                                MessageBubble(role: .user, text: text)
                            case .entry(_, let entry):
                                AgentLogRow(entry: entry)
                            }
                        }
                        if chat.isThinking {
                            HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Thinking…") }
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding()
                }
                .onChange(of: chat.rows.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            if let err = chat.error {
                HStack(spacing: Spacing.s) {
                    Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
                    Text(err).font(.footnote).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal).padding(.vertical, 4)
            }
            HStack(spacing: 4) {
                if let models = modelConfig?.availableModels, !models.isEmpty {
                    Menu {
                        ForEach(models, id: \.self) { m in
                            Button { Task { await chat.setModel(m) } } label: {
                                if m == (chat.model ?? modelConfig?.claudeModel) { Label(m, systemImage: "checkmark") } else { Text(m) }
                            }
                        }
                    } label: {
                        Label(chat.model ?? modelConfig?.claudeModel ?? "model", systemImage: "cpu")
                            .font(.caption).padding(.leading, 12)
                    }
                    .disabled(chat.status == .disconnected)
                }
                ChatComposer(placeholder: "Message the agent…", disabled: !chat.canSend) { text in
                    await chat.send(text)
                }
                if chat.isThinking {
                    Button { Task { await chat.interrupt() } } label: {
                        Image(systemName: "stop.circle.fill").font(.title2).foregroundStyle(.primary)
                    }
                    .padding(.trailing, 12)
                    .accessibilityLabel("Interrupt")
                }
            }
        }
    }
}
