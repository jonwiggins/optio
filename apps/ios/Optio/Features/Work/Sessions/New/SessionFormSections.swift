import SwiftUI

// The six sections of `session-form.tsx`, one view each. They read the
// state's draft and derived facts and write through its mutators so every
// change is normalized (upstream answers win).

private typealias F = SessionForm

// MARK: - When

struct WhenSection: View {
    @Bindable var state: SessionFormState

    var body: some View {
        FormSection(step: 1, label: "When", hint: "What starts it?", summary: state.summaryWhen, id: .when) {
            PillRow(
                pills: F.WhenType.allCases.map { Pill(value: $0, label: $0.label, systemImage: $0.systemImage) },
                selection: state.draft.when,
                onSelect: state.setWhen
            )
            switch state.draft.when {
            case .manual: EmptyView()
            case .schedule: scheduleConfig
            case .webhook: webhookConfig
            case .ticket: ticketConfig
            case .github, .slack, .linear: EventConfigView(state: state)
            }
        }
    }

    private var scheduleConfig: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            FieldLabel(text: "Cron expression (UTC)")
            CardTextField(placeholder: "0 9 * * *", text: Binding(
                get: { state.draft.trigger.cronExpression ?? "" },
                set: { v in state.edit { $0.trigger.cronExpression = v } }
            ), mono: true)
            FlowLayout(spacing: 6) {
                ForEach(F.cronPresets, id: \.expr) { p in
                    let on = state.draft.trigger.cronExpression == p.expr
                    Button(p.label) { state.edit { $0.trigger.cronExpression = p.expr } }
                        .font(.caption.weight(on ? .semibold : .regular))
                        .foregroundStyle(on ? AnyShapeStyle(AppTheme.accent) : AnyShapeStyle(.secondary))
                        .padding(.horizontal, Spacing.s).padding(.vertical, 4)
                        .background(.fill.tertiary, in: Capsule())
                        .buttonStyle(.plain)
                }
            }
            let cron = state.draft.trigger.cronExpression ?? ""
            if !F.cronIsValid(cron) {
                Hint(text: "Expected five space-separated fields.", tone: .accent)
            } else if let words = F.cronWords[cron.trimmingCharacters(in: .whitespaces)] {
                Hint(text: "Runs \(words).")
            } else {
                Hint(text: "Five-field cron expression (UTC).")
            }
        }
    }

    private var webhookConfig: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            FieldLabel(text: "Webhook path")
            HStack(spacing: 0) {
                Text("/api/hooks/").font(.footnote.monospaced()).foregroundStyle(.tertiary)
                TextField("hook-abc123", text: Binding(
                    get: { state.draft.trigger.webhookPath ?? "" },
                    set: { v in state.edit { $0.trigger.webhookPath = v.trimmingCharacters(in: .whitespaces) } }
                ))
                .font(.body.monospaced()).textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            .padding(.horizontal, Spacing.m).padding(.vertical, 9)
            .background(Color(.tertiarySystemGroupedBackground), in: Radius.smallShape)
            Hint(text: "POST to this path to trigger a run. Path must be unique across the workspace.")
        }
    }

    private var ticketConfig: some View {
        TicketConfigView(state: state)
    }
}

private struct TicketConfigView: View {
    @Bindable var state: SessionFormState
    @State private var labelInput = ""

    private var labels: [String] { state.draft.trigger.ticketLabels ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            FieldLabel(text: "Source")
            SegmentedChoice(options: F.TicketSource.allCases.map { ($0, $0.label) }, selection: state.draft.trigger.ticketSource ?? .github) { s in
                state.edit { $0.trigger.ticketSource = s }
            }
            FieldLabel(text: "Labels", optional: true)
            HStack(spacing: Spacing.s) {
                CardTextField(placeholder: "e.g. cve, bug", text: $labelInput)
                    .onSubmit(addLabel)
                Button("Add", action: addLabel).font(.subheadline.weight(.medium)).disabled(labelInput.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if !labels.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(labels, id: \.self) { l in
                        HStack(spacing: 4) {
                            Text(l).font(.caption)
                            Button { state.edit { $0.trigger.ticketLabels = labels.filter { $0 != l } } } label: {
                                Image(systemName: "xmark").font(.caption2.weight(.bold))
                            }
                            .buttonStyle(.plain).accessibilityLabel("Remove \(l)")
                        }
                        .padding(.horizontal, Spacing.s).padding(.vertical, 4)
                        .background(.fill.tertiary, in: Capsule())
                    }
                }
            }
            Hint(text: "Only tickets with at least one matching label fire this trigger. Leave empty to match all tickets from the source.")
        }
    }

    private func addLabel() {
        let t = labelInput.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        if !labels.contains(t) { state.edit { $0.trigger.ticketLabels = labels + [t] } }
        labelInput = ""
    }
}

/// Event-trigger config (GitHub events + login, Slack channel + mention-only,
/// Linear events + user), in the shape `/api/local/blueprints/:id/triggers` stores.
private struct EventConfigView: View {
    @Bindable var state: SessionFormState

    private var type: F.EventTriggerType { state.draft.event.type }
    private var config: [String: AnyCodable] { state.draft.event.config }
    private var events: [String] { config["events"]?.arrayValue?.compactMap(\.stringValue) ?? [] }
    private var kinds: [F.EventKind] { type == .github ? F.githubKinds : type == .linear ? F.linearKinds : [] }
    private var personal: Bool { kinds.contains { $0.personal && events.contains($0.value) } }

    private func set(_ key: String, _ value: AnyCodable) {
        state.edit { $0.event.config[key] = value }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            if type == .slack {
                FieldLabel(text: "Channel id")
                CardTextField(placeholder: "C0123ABCD", text: Binding(
                    get: { config["channelId"]?.stringValue ?? "" },
                    set: { set("channelId", .string($0.trimmingCharacters(in: .whitespaces))) }
                ), mono: true)
                Toggle("Only when the bot is @-mentioned", isOn: Binding(
                    get: { config["mentionOnly"]?.boolValue ?? false },
                    set: { set("mentionOnly", .bool($0)) }
                ))
                .font(.subheadline).tint(AppTheme.accent)
            } else {
                ForEach(kinds, id: \.value) { k in
                    Toggle(k.label, isOn: Binding(
                        get: { events.contains(k.value) },
                        set: { on in
                            let next = on ? events + [k.value] : events.filter { $0 != k.value }
                            set("events", .array(next.map { .string($0) }))
                        }
                    ))
                    .font(.subheadline).tint(AppTheme.accent)
                }
                if personal {
                    let key = type == .github ? "login" : "user"
                    FieldLabel(text: type == .github ? "Your GitHub username" : "Your Linear name or user id")
                    CardTextField(placeholder: type == .github ? "octocat" : "Jane Doe", text: Binding(
                        get: { config[key]?.stringValue ?? "" },
                        set: { v in set(key, .string(v.hasPrefix("@") ? String(v.dropFirst()) : v)) }
                    ))
                }
            }
            Hint(text: "Event triggers run sessions on your machine. Each firing opens one in the chosen directory with the event's fields available as {{param}}s.")
        }
    }
}

// MARK: - Where

struct WhereSection: View {
    @Bindable var state: SessionFormState

    private var noHosts: Bool { !state.hostsLoading && state.hosts.isEmpty }

    var body: some View {
        let wheres = F.whereOptions(state.draft)
        let podDisabled = wheres.first { $0.value == .cluster }?.disabled
        FormSection(step: 2, label: "Where", hint: "A pod, or your machine?", summary: state.summaryWhere, id: .where) {
            ChoiceCard(
                systemImage: "server.rack",
                title: "Optio pod",
                description: state.draft.withRepo
                    ? "An isolated pod clones one of your registered repos into a fresh worktree. Uses the server's agent credentials."
                    : "An isolated pod with no repo checkout. Uses the server's agent credentials and Connections.",
                active: !state.isLocal,
                disabled: podDisabled
            ) { state.setWhere(.cluster) }
            ChoiceCard(
                systemImage: "laptopcomputer",
                title: "My machine",
                description: state.draft.withRepo
                    ? "A git checkout on a paired machine, with your local agent CLI and its login. The agent works on a branch there and opens the PR."
                    : "A directory on a paired machine, with your local agent CLI and its login. The session shows up under Local too.",
                active: state.isLocal,
                disabled: noHosts ? "No paired machine — run `optio local up` on your computer first." : state.hostsLoading && state.hosts.isEmpty ? "Looking for paired machines…" : nil
            ) { state.setWhere(.local) }

            Divider()

            if state.isLocal { machineDetails } else { podDetails }
        }
    }

    // A machine: host + directory, then "Current directory | New branch".
    @ViewBuilder
    private var machineDetails: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            FieldLabel(text: "Machine")
            Picker("Machine", selection: Binding(get: { state.draft.location.localHostId }, set: state.setHost)) {
                ForEach(state.hosts, id: \.id) { h in
                    Text(h.state == .offline ? "\(h.name) (offline)" : h.name).tag(h.id)
                }
            }
            .pickerStyle(.menu).labelsHidden().tint(.primary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Spacing.s).padding(.vertical, 4)
            .background(Color(.tertiarySystemGroupedBackground), in: Radius.smallShape)
            if state.host?.state == .offline {
                Hint(text: "Offline — runs wait in the queue until this machine reconnects.", tone: .accent)
            }
        }

        let dirs = state.host?.dirs ?? []
        VStack(alignment: .leading, spacing: Spacing.xs) {
            FieldLabel(text: state.draft.withRepo ? "Checkout" : "Directory")
            if dirs.isEmpty {
                Hint(text: "No directories on this machine — run `optio local add <dir>` there.", tone: .accent)
            } else {
                Menu {
                    ForEach(dirs, id: \.path) { d in
                        Button {
                            state.edit { $0.location.localDir = d.path }
                        } label: {
                            if d.path == state.draft.location.localDir { Label(d.path, systemImage: "checkmark") } else { Text(d.path) }
                            if !state.usableDir(d) { Text("not a git checkout") }
                        }
                        .disabled(!state.usableDir(d))
                    }
                } label: {
                    HStack {
                        Text(state.draft.location.localDir.isEmpty ? (state.draft.withRepo ? "Pick a checkout…" : "Pick a directory…") : F.shortDir(state.draft.location.localDir))
                            .font(state.draft.location.localDir.isEmpty ? .body : .body.monospaced())
                            .foregroundStyle(state.draft.location.localDir.isEmpty ? .secondary : .primary)
                            .lineLimit(1).truncationMode(.middle)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, Spacing.m).padding(.vertical, 9)
                    .background(Color(.tertiarySystemGroupedBackground), in: Radius.smallShape)
                    .contentShape(Radius.smallShape)
                }
                .buttonStyle(.plain)
                if state.draft.withRepo, !dirs.contains(where: { $0.repoUrl != nil }) {
                    Hint(text: "None of this machine's directories is a git checkout — add one with `optio local add <checkout>`, or pick Current directory below.", tone: .accent)
                }
            }
        }

        SegmentedChoice(options: [(false, "Current directory"), (true, "New branch")], selection: state.draft.withRepo, onSelect: state.setWithRepo)
        if state.draft.withRepo {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                FieldLabel(text: "Base branch")
                CardTextField(placeholder: "main", text: Binding(get: { state.draft.repoBranch }, set: { v in state.edit { $0.repoBranch = v } }), mono: true)
                if let repo = state.localRepoUrl {
                    Hint(text: "Repo: \(F.shortRepo(repo)) — the agent branches off this in the checkout and opens a PR against it.")
                } else {
                    Hint(text: "The agent branches off this in the checkout and opens a PR against it.")
                }
            }
        } else {
            Hint(text: "Works in the directory as it is, on whatever branch is checked out. Nothing is pushed unless you or the agent do it.")
        }
    }

    // A pod: "A repository | No repo", then repo + branch.
    @ViewBuilder
    private var podDetails: some View {
        SegmentedChoice(options: [(true, "A repository"), (false, "No repo")], selection: state.draft.withRepo, onSelect: state.setWithRepo)
        if state.draft.withRepo {
            if state.reposLoading {
                HStack(spacing: Spacing.s) { ProgressView(); Text("Loading repos…").font(.footnote).foregroundStyle(.secondary) }
            } else if state.repos.isEmpty {
                Hint(text: "No repos configured. Add a repo under Library › Repos first, or pick My machine above.", tone: .accent)
            } else {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    FieldLabel(text: "Repository")
                    Picker("Repository", selection: Binding(get: { state.draft.repoId }, set: state.setRepo)) {
                        ForEach(state.repos) { r in Text("\(r.fullName) (\(r.defaultBranch))").tag(r.id) }
                    }
                    .pickerStyle(.menu).labelsHidden().tint(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Spacing.s).padding(.vertical, 4)
                    .background(Color(.tertiarySystemGroupedBackground), in: Radius.smallShape)
                }
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    FieldLabel(text: "Branch")
                    CardTextField(placeholder: "main", text: Binding(get: { state.draft.repoBranch }, set: { v in state.edit { $0.repoBranch = v } }), mono: true)
                }
            }
        } else {
            Hint(text: "No checkout — results are logs and side effects through Connections.")
        }
    }
}

// MARK: - Who

struct WhoSection: View {
    @Bindable var state: SessionFormState

    var body: some View {
        let runtimes = F.runtimeOptions(state.draft)
        let disabledOnes = runtimes.filter { !$0.isEnabled }
        FormSection(step: 3, label: "Who", hint: "A terminal, or an agent?", summary: state.summaryWho, id: .who) {
            PillRow(
                pills: runtimes.map { r in
                    Pill(value: r.value, label: r.value == F.terminal ? "Terminal" : F.runtimeLabel(r.value),
                         systemImage: r.value == F.terminal ? "terminal" : "cpu",
                         disabled: r.disabled.map { "\(r.value == F.terminal ? "Terminal" : F.runtimeLabel(r.value)) — \($0)" })
                },
                selection: state.draft.runtime,
                onSelect: state.setRuntime
            )
            Hint(text: whoHint(disabledOnes))
            if !state.isTerminal {
                Divider()
                HStack(alignment: .firstTextBaseline) {
                    Text("\(F.runtimeLabel(state.draft.runtime)) parameters").font(.footnote).foregroundStyle(.secondary)
                    Spacer()
                    Text(state.isLocal
                        ? "Only the model — the rest comes from the machine's own config"
                        : state.draft.withRepo
                            ? "Starts from the repo's defaults; applies to this session only"
                            : "Blank means the runtime's default")
                        .font(.caption2).foregroundStyle(.tertiary).multilineTextAlignment(.trailing)
                }
                AgentOptionsPickerView(
                    provider: state.provider,
                    state: state.catalogs.state(state.provider),
                    values: state.draft.agentOptions,
                    modelOnly: !state.fullOptionsApply,
                    onChange: state.setOption
                )
            }
        }
        .task(id: state.draft.runtime) { state.loadCatalog() }
        .onChange(of: state.catalogs.states.count) { _, _ in state.seedOptionsIfNeeded() }
    }

    private func whoHint(_ disabled: [F.Choice<String>]) -> String {
        var s = state.isTerminal ? "Just you at a shell prompt — no agent, no prompt."
            : state.isLocal ? "Uses the CLI and login already on the machine."
            : "Runs with the server's agent credentials."
        if let first = disabled.first {
            let names = disabled.map { $0.value == F.terminal ? "Terminal" : F.runtimeLabel($0.value) }.joined(separator: ", ")
            var why = first.disabled ?? ""
            if why.hasSuffix(".") { why.removeLast() }
            s += " \(names) — \(why)."
        }
        return s
    }
}

// MARK: - What

struct WhatSection: View {
    @Bindable var state: SessionFormState
    let editor: PromptEditorController

    private var placeholder: String {
        switch state.draft.when {
        case .ticket, .linear: return "{{ticketUrl}}, please triage this ticket."
        case .github: return "Review {{url}} and leave comments on anything risky."
        default:
            if state.draft.then == .waitsForMessages { return "Who this agent is and what it should do on its first turn." }
            return state.draft.withRepo
                ? "Describe the change. Be specific about files to modify and expected behavior."
                : "Describe what the agent should do. Reference Connections for external systems."
        }
    }

    var body: some View {
        FormSection(step: 4, label: "What", hint: "The prompt", id: .prompt) {
            HStack {
                FieldLabel(text: state.draft.then == .waitsForMessages ? "Initial prompt" : "Prompt", optional: state.kind == .localTerminal)
                Spacer()
                if !state.templates.isEmpty {
                    Menu {
                        ForEach(state.templates) { t in
                            Button(t.name) { state.edit { $0.prompt = t.template ?? "" } }
                        }
                    } label: {
                        Label("Saved prompt", systemImage: "text.book.closed").font(.footnote)
                    }
                }
            }
            PromptEditor(text: Binding(get: { state.draft.prompt }, set: { v in state.edit { $0.prompt = v } }), placeholder: placeholder, controller: editor)
            if state.draft.when != .manual {
                if !state.params.isEmpty {
                    Hint(text: "From the \(state.draft.when.label) trigger — tap to insert:")
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(state.params, id: \.self) { p in
                                Button("{{\(p)}}") {
                                    state.edit { d in editor.insert("{{\(p)}}", into: &d.prompt) }
                                }
                                .font(.caption.monospaced())
                                .foregroundStyle(.primary)
                                .padding(.horizontal, Spacing.s).padding(.vertical, 4)
                                .background(.fill.tertiary, in: Radius.smallShape)
                                .buttonStyle(.plain)
                            }
                        }
                    }
                } else if state.draft.when == .webhook {
                    Hint(text: "Any top-level field of the POSTed JSON is available as {{field}}.")
                } else {
                    Hint(text: "A schedule carries no parameters.")
                }
            }
        }
    }
}

// MARK: - Exit conditions

struct ThenSection: View {
    @Bindable var state: SessionFormState

    private static let cards: [F.Then: (icon: String, title: String, subtitle: String, description: String)] = [
        .exits: ("rectangle.portrait.and.arrow.right", "Exit when done", "A one-shot run",
                 "The agent does one turn of work and the session finishes. On a branch, it opens the PR first."),
        .waitsForMe: ("terminal", "Wait for me", "An interactive session",
                      "Stops at its prompt after each turn and lands in your “needs you” queue until you type."),
        .waitsForMessages: ("cpu", "Persistent agent", "Stays reachable",
                            "Named and addressable. Keeps its memory between turns and wakes when a person or another agent messages it."),
    ]

    var body: some View {
        FormSection(step: state.isTerminal ? 4 : 5, label: "Then", hint: "What happens when a turn ends?", summary: state.summaryThen, id: .then) {
            ForEach(F.thenOptions(state.draft), id: \.value) { c in
                let meta = Self.cards[c.value]!
                ChoiceCard(systemImage: meta.icon, title: meta.title, subtitle: meta.subtitle, description: meta.description,
                           active: state.draft.then == c.value, disabled: c.disabled) { state.setThen(c.value) }
            }
            if state.draft.then == .waitsForMessages {
                Divider()
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    FieldLabel(text: "Pod lifecycle")
                    SegmentedChoice(options: F.PodLifecycle.allCases.map { ($0, $0.label) }, selection: state.draft.agent.podLifecycle) { v in
                        state.edit { $0.agent.podLifecycle = v }
                    }
                    Hint(text: state.draft.agent.podLifecycle.hint)
                }
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    FieldLabel(text: "System prompt", optional: true)
                    CardTextEditor(placeholder: "Persona — who is this agent?", text: Binding(get: { state.draft.agent.systemPrompt }, set: { v in state.edit { $0.agent.systemPrompt = v } }))
                }
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    FieldLabel(text: "Operator manual (agents.md)", optional: true)
                    CardTextEditor(placeholder: "Blank = Optio's standard manual (messaging other agents, reading the inbox, finishing a turn).", text: Binding(get: { state.draft.agent.agentsMd }, set: { v in state.edit { $0.agent.agentsMd = v } }), mono: true)
                }
            }
        }
    }
}

// MARK: - Name (+ More)

struct NameSection: View {
    @Bindable var state: SessionFormState

    private var activeTasks: [TaskRow] { state.existingTasks.filter { !["completed", "cancelled"].contains($0.state) } }

    var body: some View {
        FormSection(step: state.isTerminal ? 5 : 6, label: "Name", summary: state.summaryName, id: .name) {
            CardTextField(placeholder: state.autoName, text: Binding(get: { state.draft.name }, set: { v in state.edit { $0.name = v } }))
                .textInputAutocapitalization(.sentences)
            if state.draft.name.trimmingCharacters(in: .whitespaces).isEmpty {
                Hint(text: "Leave blank to call it “\(state.autoName)”.")
            } else if state.kind == .repoTask || state.kind == .repoBlueprint {
                Hint(text: "Also the title of the task that opens the PR.")
            }
            if state.draft.then == .waitsForMessages {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    FieldLabel(text: "Address")
                    CardTextField(placeholder: F.slugify(state.draft.name.trimmingCharacters(in: .whitespaces).isEmpty ? state.autoName : state.draft.name),
                                  text: Binding(get: { state.draft.agent.slug }, set: { v in state.edit { $0.agent.slug = F.slugify(v) } }), mono: true)
                    Hint(text: "How other agents message it.")
                }
            }

            DisclosureGroup(isExpanded: $state.more) {
                VStack(alignment: .leading, spacing: Spacing.m) {
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        FieldLabel(text: "Description", optional: true)
                        CardTextField(placeholder: "Why does this session exist? Who asked for it?", text: Binding(get: { state.draft.description }, set: { v in state.edit { $0.description = v } }))
                            .textInputAutocapitalization(.sentences)
                    }
                    if state.draft.then == .exits {
                        if state.draft.withRepo {
                            Stepper(value: Binding(get: { state.draft.priority }, set: { v in state.edit { $0.priority = v } }), in: 1...1000, step: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Priority: \(state.draft.priority)").font(.subheadline)
                                    Text("Lower = sooner. Default 100.").font(.caption).foregroundStyle(.tertiary)
                                }
                            }
                        }
                        Stepper(value: Binding(get: { state.draft.maxRetries }, set: { v in state.edit { $0.maxRetries = v } }), in: 0...10) {
                            Text("Max retries: \(state.draft.maxRetries)").font(.subheadline)
                        }
                    }
                    if state.kind == .repoTask {
                        DisclosureGroup(isExpanded: $state.showDeps) {
                            if activeTasks.isEmpty {
                                Hint(text: "Nothing to wait on.")
                            } else {
                                Hint(text: "Wait for these sessions to complete first.")
                                ForEach(activeTasks.prefix(40)) { t in
                                    Toggle(isOn: Binding(
                                        get: { state.draft.dependsOn.contains(t.id) },
                                        set: { on in state.edit { $0.dependsOn = on ? $0.dependsOn + [t.id] : $0.dependsOn.filter { $0 != t.id } } }
                                    )) {
                                        HStack {
                                            Text(t.title).font(.footnote).lineLimit(1)
                                            Spacer()
                                            Text(t.state).font(.caption).foregroundStyle(.tertiary)
                                        }
                                    }
                                    .tint(AppTheme.accent)
                                }
                            }
                        } label: {
                            Label(state.draft.dependsOn.isEmpty ? "Dependencies" : "Dependencies (\(state.draft.dependsOn.count))", systemImage: "link")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.top, Spacing.s)
            } label: {
                Text("More").font(.footnote).foregroundStyle(.secondary)
            }
            .tint(.secondary)
        }
    }
}
