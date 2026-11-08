import SwiftUI

/// The workspace owns connections; this view only presents one conversation.
struct OptioConversationView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppRouter.self) private var router
    @Environment(SessionStore.self) private var session
    @Bindable var model: OptioAssistantModel
    @State private var followsLatest = true
    @State private var navigationError: String?
    @FocusState private var composerFocused: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // History is bounded by the server. Eager layout keeps long, selectable
                // replies stable while scrolling (iOS 26 lazy placement can loop).
                VStack(alignment: .leading, spacing: 18) {
                    if model.rows.isEmpty {
                        if model.hasLoadedHistory || !session.canCreateWork { introduction }
                        else { loadingConversation }
                    }
                    ForEach(Array(model.rows.enumerated()), id: \.element.id) { index, row in
                        message(row, showsAuthor: index == 0 || model.rows[index - 1].role != row.role || row.isError || row.proposal != nil)
                    }
                    if !model.queue.isEmpty { queuedMessages }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding()
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .simultaneousGesture(DragGesture(minimumDistance: 12).onChanged { _ in if followsLatest { followsLatest = false } })
            .overlay(alignment: .bottomTrailing) {
                if !followsLatest && !model.rows.isEmpty {
                    Button {
                        followsLatest = true
                        withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                    } label: { Label("Latest", systemImage: "arrow.down") }
                        .font(.caption.weight(.semibold)).buttonStyle(.borderedProminent)
                        .clipShape(Capsule()).padding(12).accessibilityLabel("Latest messages")
                }
            }
            .onAppear { if model.hasLoadedHistory { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: model.hasLoadedHistory) { _, loaded in
                if loaded { followsLatest = true; Task { @MainActor in await Task.yield(); proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            .onChange(of: model.rows.last?.text) { _, _ in if followsLatest { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: model.rows.count) { _, _ in if followsLatest { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: model.queue.count) { _, _ in if followsLatest { proxy.scrollTo("bottom", anchor: .bottom) } }
        }
        .background(Surface.page)
        .safeAreaInset(edge: .top, spacing: 0) { conversationStatus }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == nil else { return .systemAction }
            Task { await openWork(url) }
            return .handled
        })
    }

    private var conversationStatus: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Circle().fill(model.status == .ready ? Color.green : AppTheme.accent).frame(width: 6, height: 6)
                Text(model.statusLabel).font(.caption.weight(.medium))
                Spacer(minLength: 8)
                if let identity = model.identity {
                    Text(identity).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        .accessibilityIdentifier("Agent identity")
                }
            }
            if let error = model.connectionError {
                HStack(alignment: .top) {
                    Text(error).font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Button("Reconnect") { model.reconnect(api: api) }.font(.caption.weight(.semibold))
                }
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
        .background(Surface.page)
        .overlay(alignment: .bottom) { Divider().opacity(0.45) }
    }

    private var loadingConversation: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading conversation…").font(.subheadline).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 56)
        .accessibilityIdentifier("Loading conversation")
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: "sparkles").font(.system(size: 26)).foregroundStyle(AppTheme.accent)
                .padding(12).background(AppTheme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
            Text(session.canCreateWork ? "What would you like to do?" : "Optio Agent requires member access")
                .font(.title3.weight(.semibold))
            Text("Find work, plan a change, or start something new.").font(.subheadline).foregroundStyle(.secondary)
            VStack(spacing: 8) {
                suggestion("Start work on my machine", prompt: "Help me start work on my machine", icon: "laptopcomputer")
                suggestion("See what’s running", prompt: "Show me my active work", icon: "list.bullet")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 28)
    }

    private func suggestion(_ title: String, prompt: String, icon: String) -> some View {
        Button { model.draft = prompt; composerFocused = true } label: {
            HStack(spacing: 10) {
                Image(systemName: icon).frame(width: 20)
                Text(title).font(.subheadline)
                Spacer()
                Image(systemName: "arrow.up.left").font(.caption)
            }.padding(12).background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 12))
        }.buttonStyle(.plain).accessibilityLabel(prompt)
    }

    private var queuedMessages: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Up next · \(model.queue.count)", systemImage: "text.line.first.and.arrowtriangle.forward")
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(model.queue) { item in
                HStack(alignment: .top, spacing: 12) {
                    Text(item.content).font(.subheadline).textSelection(.enabled)
                    Spacer(minLength: 0)
                    Button { Task { await model.cancelQueued(item.requestId) } } label: {
                        Image(systemName: "xmark.circle").font(.body).frame(minWidth: 32, minHeight: 32)
                    }
                    .accessibilityLabel("Cancel queued message")
                    .disabled(!model.canSend || model.cancellingRequests.contains(item.requestId))
                }.padding(12).background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 12))
            }
        }.accessibilityIdentifier("Queued messages")
    }

    private func message(_ row: OptioAssistantModel.Row, showsAuthor: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if row.role != "user" && showsAuthor {
                Label(row.isError ? "Notice" : "Optio Agent", systemImage: row.isError ? "exclamationmark.circle" : "sparkles")
                    .font(.caption.weight(.semibold)).foregroundStyle(row.isError ? Color.red : AppTheme.secondaryText)
            }
            ChatMarkdown(text: row.text)
                .font(.body).lineSpacing(3).textSelection(.enabled)
                .foregroundStyle(row.isError ? Color.red : Color.primary)
                .fixedSize(horizontal: false, vertical: true)
            if let proposal = row.proposal {
                ForEach(Array(proposal.work.enumerated()), id: \.offset) { _, work in workPreview(work) }
                if !proposal.items.isEmpty {
                    DisclosureGroup("Action details") {
                        ForEach(Array(proposal.items.enumerated()), id: \.offset) { _, item in
                            Text(item).font(.caption.monospaced()).textSelection(.enabled)
                        }
                    }.font(.subheadline)
                }
                if let decision = proposal.decision { Text(decision).font(.caption).foregroundStyle(.secondary) }
                else {
                    ViewThatFits(in: .horizontal) {
                        HStack { approvalButtons(proposal.id) }
                        VStack(alignment: .leading) { approvalButtons(proposal.id) }
                    }
                    .disabled(!model.hasLoadedHistory || model.status != .waitingForApproval)
                }
            }
        }
        .padding(row.role == "user" || row.proposal != nil ? 14 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(row.role == "user" ? AppTheme.accent.opacity(0.08) : row.proposal != nil ? Color.secondary.opacity(0.05) : .clear, in: RoundedRectangle(cornerRadius: 16))
        .padding(.leading, row.role == "user" ? 32 : 0)
        .padding(.bottom, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Conversation message")
    }

    @ViewBuilder private func approvalButtons(_ id: String) -> some View {
        Button("Approve") { Task { await model.decide(id: id, approve: true) } }.buttonStyle(.borderedProminent)
        Button("Decline") { Task { await model.decide(id: id, approve: false) } }.buttonStyle(.bordered)
    }

    private func workPreview(_ work: [String: Any]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(work["name"] as? String ?? "New work").font(.headline)
            ForEach([("when", "When"), ("where", "Where"), ("who", "Who"), ("what", "What"), ("then", "Then")], id: \.0) { key, title in
                if let value = work[key] {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(title).font(.caption.bold()).foregroundStyle(.secondary)
                        Text(previewText(key, value)).font(.footnote).textSelection(.enabled)
                    }
                }
            }
            // Keep every setting reviewable, including permissions, setup and owner.
            DisclosureGroup("All settings") {
                Text(OptioAssistantModel.json(work)).font(.caption.monospaced()).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.font(.footnote)
        }
        .padding(12)
        .background(Surface.page, in: RoundedRectangle(cornerRadius: 10))
    }

    private func previewText(_ key: String, _ value: Any) -> String {
        let object = value as? [String: Any] ?? [:]
        switch key {
        case "when":
            let type = object["type"] as? String ?? "manual"
            if type == "manual" { return "Now / on demand" }
            return type.capitalized + (object["config"].map { "\n" + OptioAssistantModel.json($0) } ?? "")
        case "where":
            var lines = [object["runTarget"] as? String == "local" ? "Your machine" : "Optio pod"]
            for (field, label) in [("localHostId", "Machine"), ("localDir", "Directory"), ("repoUrl", "Repo"), ("repoBranch", "Branch")] {
                if let text = object[field] as? String, !text.isEmpty { lines.append("\(label): \(text)") }
            }
            return lines.joined(separator: "\n")
        case "who":
            let runtime = object["runtime"] as? String ?? "terminal"
            var text = runtime == "terminal" ? "Terminal" : WorkFeed.runtimeLabel(runtime)
            if let model = object["model"] as? String { text += " · \(model)" }
            if let options = object["agentOptions"] as? [String: Any], !options.isEmpty { text += "\n" + OptioAssistantModel.json(options) }
            return text
        case "what":
            var text = object["prompt"] as? String ?? ""
            if text.isEmpty { text = "No initial prompt" }
            if let title = object["runTitle"] as? String { text += "\nRun title: \(title)" }
            return text
        case "then":
            switch value as? String {
            case "exits": return "Exits when done"
            case "waits-for-me": return "Waits for me"
            case "waits-for-messages": return "Waits for messages"
            case "until-merged": return "Works until merged"
            default: return OptioAssistantModel.json(value)
            }
        default: return OptioAssistantModel.json(value)
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let navigationError { Text(navigationError).font(.caption).foregroundStyle(.red) }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message Optio…", text: $model.draft, axis: .vertical)
                    .lineLimit(1...5).padding(.vertical, 10).padding(.leading, 14)
                    .accessibilityLabel("Message to Optio").focused($composerFocused)
                Button { followsLatest = true; Task { await model.send() } } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 30)).frame(width: 44, height: 44)
                }
                .accessibilityLabel("Send message")
                .disabled(!model.canSend || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 22))
            HStack {
                Text(model.isSending ? "Sending…" : model.status == .thinking || model.status == .executing || model.status == .waitingForApproval ? "New messages join the queue" : "Use your keyboard microphone to dictate")
                    .font(.caption2).foregroundStyle(.secondary)
                Spacer()
                if composerFocused {
                    Button { composerFocused = false } label: { Image(systemName: "keyboard.chevron.compact.down").frame(width: 36, height: 28) }
                        .accessibilityLabel("Hide keyboard")
                }
            }.padding(.horizontal, 4)
        }
        .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 8)
        .background(Surface.page)
    }

    private func openWork(_ url: URL) async {
        let parts = url.path.split(separator: "/").map(String.init)
        guard let first = parts.first, ["work", "tasks", "local", "sessions", "jobs", "agents"].contains(first) else {
            navigationError = "Open this link from the web app."
            return
        }
        if parts.count == 1 { router.open(.work); return }
        guard let id = parts.last, UUID(uuidString: id) != nil else { return }
        struct Resolved: Decodable { let source: String }
        do {
            let work: Resolved = try await api.get("/api/work/\(id)")
            let destination: WorkDestination
            switch work.source {
            case "repo-task": destination = .task(id)
            case "repo-blueprint": destination = .blueprint(id)
            case "standalone": destination = .job(id)
            case "local-terminal": destination = .localTerminal(id)
            case "local-blueprint": destination = .localBlueprint(id)
            case "pod-session": destination = .podSession(id)
            case "persistent-agent": destination = .agent(id)
            default: navigationError = "Find this item in Work."; return
            }
            router.createdWork = destination
            router.open(.work)
        } catch { navigationError = "Couldn’t open this work: \(error.localizedDescription)" }
    }
}

struct AskOptioButton: View {
    @Environment(AppRouter.self) private var router
    @Environment(SessionStore.self) private var session
    var body: some View {
        if session.canCreateWork {
            Button { router.open(.assistant) } label: { Label("Optio Agent", systemImage: "sparkles") }
        }
    }
}
