import SwiftUI

/// Chat-first detail for one persistent agent. Chips: Chat · Turns · Triggers · Config.
struct AgentDetailView: View {
    let agentId: String
    /// Deep link `?compose=1` (Live Activity "Reply…"): land on Chat with the composer ready.
    var focusComposer = false
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var model: AgentDetailModel?
    @State private var section: Section = .chat
    @State private var showEdit = false
    @State private var showNewTrigger = false
    @State private var confirmArchive = false
    @State private var confirmDelete = false

    enum Section: Hashable { case chat, turns, triggers, config }

    var body: some View {
        Group {
            if let model {
                content(model)
            } else {
                ProgressView()
            }
        }
        .task(id: agentId) {
            if model == nil { model = AgentDetailModel(agentId: agentId, api: api) }
            await model?.start()
        }
        .onDisappear { model?.stop() }
    }

    @ViewBuilder
    private func content(_ model: AgentDetailModel) -> some View {
        VStack(spacing: 0) {
            if let agent = model.agent {
                header(agent, model: model)
            } else if let error = model.error {
                ErrorBanner(error: error) { Task { await model.refreshAgent() } }
            } else {
                ProgressView().padding()
            }
            ChipPicker(options: [
                (Section.chat, "Chat"),
                (Section.turns, "Turns (\(model.turns.count))"),
                (Section.triggers, "Triggers"),
                (Section.config, "Config"),
            ], selection: $section)
            if let actionError = model.actionError {
                ErrorBanner(error: actionError)
            }
            Divider()
            switch section {
            case .chat: AgentChatSection(model: model, focusComposer: focusComposer)
            case .turns: AgentTurnsSection(model: model)
            case .triggers: AgentTriggersSection(model: model, showNew: $showNewTrigger)
            case .config: AgentConfigSection(model: model, showEdit: $showEdit)
            }
        }
        .navigationTitle(model.agent?.name ?? "Agent")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if let agent = model.agent {
                    Menu {
                        if agent.state == .paused || agent.state == .failed {
                            Button { Task { await model.control(.resume) } } label: { Label("Resume", systemImage: "play") }
                        } else if agent.state != .archived {
                            Button { Task { await model.control(.pause) } } label: { Label("Pause", systemImage: "pause") }
                        }
                        Button { Task { await model.control(.restart) } } label: { Label("Restart", systemImage: "arrow.counterclockwise") }
                        Button { showEdit = true } label: { Label("Edit", systemImage: "pencil") }
                        Divider()
                        if agent.state != .archived {
                            Button(role: .destructive) { confirmArchive = true } label: { Label("Archive", systemImage: "archivebox") }
                        }
                        Button(role: .destructive) { confirmDelete = true } label: { Label("Delete", systemImage: "trash") }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
        .confirmationDialog("Archive this agent?", isPresented: $confirmArchive, titleVisibility: .visible) {
            Button("Archive", role: .destructive) { Task { await model.control(.archive) } }
        } message: {
            Text("Archived agents stop waking and are kept for history.")
        }
        .confirmationDialog("Delete this agent and all its turn history?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await model.delete() } }
        }
        .onChange(of: model.deleted) { _, deleted in
            if deleted { dismiss() }
        }
        .sheet(isPresented: $showEdit) {
            if let agent = model.agent {
                AgentFormSheet(mode: .edit(agent)) { _ in Task { await model.refreshAgent() } }
            }
        }
        .sheet(isPresented: $showNewTrigger) {
            AgentTriggerSheet(agentId: agentId) { Task { await model.refreshTriggers() } }
        }
    }

    private func header(_ agent: PersistentAgent, model: AgentDetailModel) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("@\(agent.slug)").font(.caption.monospaced()).foregroundStyle(.secondary)
                StatusBadge(text: agent.state.rawValue, color: StateColor.color(for: agent.state.rawValue))
                if model.connected {
                    Image(systemName: "dot.radiowaves.left.and.right").font(.caption2).foregroundStyle(.green)
                }
                Spacer()
            }
            if let d = agent.description, !d.isEmpty {
                Text(d).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    Label(agent.agentRuntime, systemImage: "cpu")
                    Label(agent.podLifecycle.rawValue, systemImage: "shippingbox")
                    Label(String(format: "$%.4f lifetime", Double(agent.totalCostUsd) ?? 0), systemImage: "dollarsign.circle")
                    if let t = agent.lastTurnAt {
                        Label("Last turn \(t.relativeDescription)", systemImage: "clock")
                    }
                    if model.inbox.pending > 0 {
                        Label("\(model.inbox.pending) pending", systemImage: "tray.full").foregroundStyle(.orange)
                    }
                    if agent.consecutiveFailures > 0 {
                        Label("\(Int(agent.consecutiveFailures)) consecutive failures", systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            if let reason = agent.lastFailureReason, !reason.isEmpty {
                Text("Last failure: \(reason)")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(3)
            }
        }
        .padding(.horizontal)
        .padding(.top, 8)
    }
}

// MARK: - Chat

/// Inbox messages as bubbles, followed by the live activity tail of the current
/// turn, in one scroll. Composer pinned at the bottom.
struct AgentChatSection: View {
    @Bindable var model: AgentDetailModel
    var focusComposer = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if model.messages.isEmpty {
                            Text("No messages yet. Send one below to wake the agent.")
                                .font(.footnote).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .padding(.top, 24)
                        }
                        ForEach(model.messages, id: \.id) { m in
                            AgentMessageBubble(message: m)
                        }
                        if !model.liveLogs.isEmpty {
                            HStack(spacing: 6) {
                                Image(systemName: "waveform")
                                Text("Live activity")
                                if let turn = model.turns.first(where: { $0.id == model.liveTurnId }) {
                                    Text("· turn #\(Int(turn.turnNumber))")
                                }
                            }
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.top, 8)
                            ForEach(Array(model.liveLogs.enumerated()), id: \.offset) { _, entry in
                                AgentLogRow(entry: entry)
                            }
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding()
                }
                .onChange(of: model.liveLogs.count) { _, _ in
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onChange(of: model.messages.count) { _, _ in
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            Divider()
            ChatComposer(
                placeholder: "Message \(model.agent?.name ?? "agent")…",
                disabled: model.agent?.state == .archived,
                autofocus: focusComposer
            ) { text in
                // Turns triggered from this phone join the Watch for an hour (brief §2c).
                RecentAgentSends.record(model.agentId)
                await model.send(text)
            }
        }
    }
}

struct AgentMessageBubble: View {
    let message: PersistentAgentMessage

    private var isUser: Bool { message.senderType == .user }
    private var tint: Color {
        switch message.senderType {
        case .user: return AppTheme.accent
        case .agent: return .blue
        default: return .secondary
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("\(message.senderType.rawValue):\(message.senderName ?? "unknown")")
                    .font(.caption2.monospaced())
                if message.broadcasted {
                    Text("broadcast").font(.caption2).padding(.horizontal, 4)
                        .background(Color.orange.opacity(0.2), in: Capsule())
                }
                Spacer()
                Text(message.receivedAt.relativeDescription).font(.caption2)
            }
            .foregroundStyle(.secondary)
            Text(message.body)
                .font(.callout)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let p = message.processedAt {
                Text("Processed \(p.relativeDescription)").font(.caption2).foregroundStyle(.tertiary)
            } else {
                Text("Pending").font(.caption2).foregroundStyle(.orange)
            }
        }
        .padding(10)
        .background(tint.opacity(isUser ? 0.12 : 0.06), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(tint.opacity(0.2)))
    }
}

// MARK: - Turns

struct AgentTurnsSection: View {
    @Bindable var model: AgentDetailModel

    var body: some View {
        List {
            if model.turns.isEmpty {
                Text("No turns yet.").foregroundStyle(.secondary)
            }
            ForEach(model.turns, id: \.id) { turn in
                NavigationLink {
                    AgentTurnDetailView(agentId: model.agentId, turn: turn)
                } label: {
                    AgentTurnRow(turn: turn)
                }
            }
        }
        .listStyle(.plain)
        .refreshable { await model.refreshTurns() }
    }
}

struct AgentTurnRow: View {
    let turn: PersistentAgentTurn

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text("Turn #\(Int(turn.turnNumber))").font(.subheadline.weight(.semibold))
                Text(turn.wakeSource.rawValue).font(.caption).foregroundStyle(.secondary)
                Spacer()
                if let halt = turn.haltReason {
                    StatusBadge(text: halt.rawValue, color: halt == .error ? .red : .secondary)
                } else {
                    StatusBadge(text: "running", color: .blue)
                }
            }
            HStack(spacing: 12) {
                Text((turn.startedAt ?? turn.createdAt).relativeDescription)
                if let c = turn.costUsd, let d = Double(c) { Text(String(format: "$%.5f", d)).monospacedDigit() }
                if let i = turn.inputTokens, let o = turn.outputTokens {
                    Text("\(Int(i))↑ \(Int(o))↓").monospacedDigit()
                }
            }
            .font(.caption2).foregroundStyle(.secondary)
            if let s = turn.summary, !s.isEmpty {
                Text(s).font(.caption).italic().foregroundStyle(.secondary).lineLimit(2)
            }
            if let e = turn.errorMessage, !e.isEmpty {
                Text(e).font(.caption).foregroundStyle(.red).lineLimit(2)
            }
        }
        .padding(.vertical, 2)
    }
}

struct AgentTurnDetailView: View {
    let agentId: String
    let turn: PersistentAgentTurn
    @Environment(APIClient.self) private var api

    var body: some View {
        Loadable {
            try await api.getPersistentAgentTurn(agentId, turnId: turn.id)
        } content: { result in
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    AgentTurnRow(turn: result.turn)
                    if let prompt = result.turn.promptUsed, !prompt.isEmpty {
                        DisclosureGroup("Prompt used") {
                            Text(prompt).font(.caption.monospaced()).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .font(.caption)
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
                Divider()
                if result.logs.isEmpty {
                    EmptyState(title: "No logs", systemImage: "doc.text", message: "This turn produced no log output.")
                } else {
                    AgentLogView(entries: result.logs.map { $0.asLogEntry(agentId: agentId) }, autoScroll: false)
                }
            }
        }
        .navigationTitle("Turn #\(Int(turn.turnNumber))")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Triggers

struct AgentTriggersSection: View {
    @Bindable var model: AgentDetailModel
    @Binding var showNew: Bool

    var body: some View {
        List {
            if model.triggers.isEmpty {
                Text("No triggers. Add a schedule or webhook to wake this agent automatically.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(model.triggers) { t in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Label(t.type.capitalized, systemImage: icon(for: t.type)).font(.subheadline.weight(.semibold))
                        Spacer()
                        if t.enabled == false { StatusBadge(text: "disabled", color: .gray) }
                    }
                    Text(t.summary).font(.caption.monospaced()).foregroundStyle(.secondary)
                    HStack(spacing: 12) {
                        if let n = t.nextFireAt { Text("Next \(n.relativeDescription)") }
                        if let l = t.lastFiredAt { Text("Last \(l.relativeDescription)") }
                    }
                    .font(.caption2).foregroundStyle(.secondary)
                }
                .swipeActions {
                    Button(role: .destructive) { Task { await model.deleteTrigger(t.id) } } label: { Label("Delete", systemImage: "trash") }
                }
            }
            Button { showNew = true } label: { Label("Add trigger", systemImage: "plus") }
        }
        .listStyle(.plain)
        .refreshable { await model.refreshTriggers() }
    }

    private func icon(for type: String) -> String {
        switch type {
        case "schedule": return "calendar.badge.clock"
        case "webhook": return "link"
        case "ticket": return "ticket"
        default: return "hand.tap"
        }
    }
}

struct AgentTriggerSheet: View {
    let agentId: String
    var onCreated: () -> Void
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var type = "schedule"
    @State private var cron = "0 9 * * 1-5"
    @State private var path = ""
    @State private var error: Error?
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                Picker("Type", selection: $type) {
                    Text("Schedule").tag("schedule")
                    Text("Webhook").tag("webhook")
                    Text("Manual").tag("manual")
                }
                if type == "schedule" {
                    Section("Cron expression") {
                        TextField("0 9 * * 1-5", text: $cron).font(.body.monospaced()).autocorrectionDisabled().textInputAutocapitalization(.never)
                    }
                } else if type == "webhook" {
                    Section("Webhook path") {
                        TextField("my-agent-hook", text: $path).autocorrectionDisabled().textInputAutocapitalization(.never)
                    }
                }
                if let error { ErrorBanner(error: error) }
            }
            .navigationTitle("New trigger")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Create") { Task { await save() } }
                        .disabled(saving || (type == "schedule" && cron.isEmpty) || (type == "webhook" && path.isEmpty))
                }
            }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        var config: [String: String] = [:]
        if type == "schedule" { config["cronExpression"] = cron }
        if type == "webhook" { config["path"] = path }
        do {
            _ = try await api.createPersistentAgentTrigger(agentId, PersistentAgentTriggerInput(type: type, config: config))
            onCreated()
            dismiss()
        } catch {
            self.error = error
        }
    }
}

// MARK: - Config

struct AgentConfigSection: View {
    @Bindable var model: AgentDetailModel
    @Binding var showEdit: Bool

    var body: some View {
        List {
            if let a = model.agent {
                Section("Settings") {
                    LabeledContent("Runtime", value: a.agentRuntime)
                    LabeledContent("Model", value: a.model ?? "default")
                    LabeledContent("Pod lifecycle", value: a.podLifecycle.rawValue)
                    LabeledContent("Idle pod TTL", value: "\(Int(a.idlePodTimeoutMs / 1000))s")
                    LabeledContent("Max turn duration", value: "\(Int(a.maxTurnDurationMs / 1000))s")
                    LabeledContent("Max turns", value: "\(Int(a.maxTurns))")
                    LabeledContent("Failure limit", value: "\(Int(a.consecutiveFailureLimit))")
                    LabeledContent("Enabled", value: a.enabled ? "Yes" : "No")
                    if let b = a.branch { LabeledContent("Branch", value: b) }
                    Button { showEdit = true } label: { Label("Edit agent", systemImage: "pencil") }
                }
                PromptBlock(title: "System prompt", text: a.systemPrompt)
                PromptBlock(title: "Operator manual (agents.md)", text: a.agentsMd)
                PromptBlock(title: "Initial prompt", text: a.initialPrompt)
            }
        }
    }
}

private struct PromptBlock: View {
    let title: String
    let text: String?
    @State private var expanded = false

    var body: some View {
        Section(title) {
            if let text, !text.isEmpty {
                Text(text)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .lineLimit(expanded ? nil : 8)
                if text.count > 400 {
                    Button(expanded ? "Show less" : "Show more") { expanded.toggle() }.font(.caption)
                }
            } else {
                Text("(empty)").italic().foregroundStyle(.secondary)
            }
        }
    }
}
