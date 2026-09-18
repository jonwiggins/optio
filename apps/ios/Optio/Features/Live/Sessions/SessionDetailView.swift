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
                    ChipPicker(options: [(Section.chat, "Chat"), (Section.terminal, "Terminal"), (Section.prs, "PRs (\(prs.count))")], selection: $section)
                }
                if let actionError { ErrorBanner(error: actionError) }
                Divider()
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
                ErrorBanner(error: error) { Task { await load() } }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if isActive {
                ToolbarItem(placement: .primaryAction) {
                    Button(role: .destructive) { confirmEnd = true } label: { Label("End", systemImage: "stop.circle") }
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
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                StatusBadge(text: s.state.rawValue, color: StateColor.color(for: s.state.rawValue))
                Label(s.repoUrl.replacingOccurrences(of: "https://github.com/", with: ""), systemImage: "folder")
                Label("Started \(s.createdAt.relativeDescription)", systemImage: "clock")
                if displayCost > 0 { Label(String(format: "$%.4f", displayCost), systemImage: "dollarsign.circle") }
                if !prs.isEmpty { Label("\(prs.count) PR\(prs.count == 1 ? "" : "s")", systemImage: "arrow.triangle.pull") }
                if let chat, isActive {
                    Label(chat.status.rawValue, systemImage: chat.isThinking ? "brain" : "circle.fill")
                        .foregroundStyle(chat.isThinking ? AppTheme.accent : (chat.canSend ? .green : .secondary))
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
    }

    private func endedBody(_ s: InteractiveSession) -> some View {
        VStack(spacing: 8) {
            EmptyState(title: "Session ended", systemImage: "terminal", message: s.endedAt.map { "Ended \($0.relativeDescription)" })
            if displayCost > 0 { Text(String(format: "Cost: $%.4f", displayCost)).font(.caption).foregroundStyle(.secondary) }
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
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.triangle.pull")
                        Text("#\(Int(pr.prNumber))").font(.subheadline.weight(.semibold))
                        StatusBadge(text: pr.prState ?? "open", color: StateColor.color(for: pr.prState ?? "open"))
                        if let c = pr.prChecksStatus { Text("checks \(c)").font(.caption2).foregroundStyle(.secondary) }
                        if let r = pr.prReviewStatus { Text("review \(r)").font(.caption2).foregroundStyle(.secondary) }
                        Spacer()
                        Image(systemName: "arrow.up.right.square").foregroundStyle(.secondary)
                    }
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
                                Text(text)
                                    .font(.callout)
                                    .textSelection(.enabled)
                                    .padding(10)
                                    .background(AppTheme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                                    .frame(maxWidth: .infinity, alignment: .trailing)
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
                Text(err).font(.footnote).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal).padding(.vertical, 4)
            }
            Divider()
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
                        Image(systemName: "stop.circle.fill").font(.title2).foregroundStyle(.red)
                    }
                    .padding(.trailing, 12)
                    .accessibilityLabel("Interrupt")
                }
            }
            .background(.bar)
        }
    }
}
