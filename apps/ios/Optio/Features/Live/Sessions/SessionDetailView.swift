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
        .navigationTitle("Session")
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
            if chat.isThinking { return chat.status == .executing ? "working" : "thinking" }
            if chat.status == .waitingForApproval { return "Needs approval" }
            return chat.canSend ? nil : chat.status.rawValue
        }()
        return SessionIdentityHeader(
            title: title,
            runtime: section == .terminal ? "terminal" : "claude-code",
            status: chatState ?? (isActive ? "Open" : "Ended"),
            tone: isActive ? .working : .idle,
            location: s.repoUrl.replacingOccurrences(of: "https://github.com/", with: ""),
            facts: Text.meta([
                Text("started \(s.createdAt.relativeDescription)"),
                Cost.formatIfNonZero(displayCost).map { Text($0) },
                prs.isEmpty ? nil : Text("\(prs.count) PR\(prs.count == 1 ? "" : "s")"),
            ]),
            usageAgent: section == .terminal ? nil : "claude-code"
        ) { EmptyView() }
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
                        titleLineLimit: 1,
                        glyph: Brand(url: pr.prUrl) == .gitlab ? .brand(.gitlab) : .pr(PRGlyphState(pr.prState))
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
            AgentLogView(entries: chat.logEntries, foldSteps: true,
                         working: chat.isThinking, sendRevision: chat.sendRevision)
                .overlay {
                    if chat.rows.isEmpty {
                        ContentUnavailableView("Start a conversation", systemImage: "text.bubble",
                                               description: Text("Send a message to work with the agent in this session."))
                    }
                }
            HStack(spacing: 0) {
                ChatActivityView(title: chat.activityTitle,
                                 active: chat.isThinking || chat.status == .connecting || (!chat.historyLoaded && chat.status != .disconnected),
                                 symbol: chat.status == .disconnected ? "wifi.exclamationmark" :
                                    chat.status == .waitingForApproval ? "person.crop.circle" :
                                    chat.status == .error ? "exclamationmark.circle" : "checkmark.circle")
                if chat.isThinking {
                    Button { Task { await chat.interrupt() } } label: {
                        Label("Stop", systemImage: "stop.fill").font(.caption.weight(.semibold))
                            .frame(minHeight: 44)
                    }
                    .disabled(chat.isInterrupting)
                    .padding(.trailing, Spacing.l)
                    .accessibilityLabel("Stop response")
                }
            }
            if let err = chat.error {
                HStack(spacing: Spacing.s) {
                    Image(systemName: "exclamationmark.circle").foregroundStyle(StatusColor.yellow)
                    Text(err).font(.footnote).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal).padding(.vertical, 4)
            }
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
                .disabled(!chat.canSend)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            ChatComposer(placeholder: "Message the agent…", disabled: !chat.canSend) { text in
                await chat.send(text)
            }
        }
    }
}
