import SwiftUI

// The six sections of `work-form.tsx`, one Form `Section` each. They read
// the state's draft and derived facts and write through its mutators so every
// change is normalized (upstream answers win). Rows are the native kinds —
// menu pickers, checkmark choices, fields, toggles — and the contextual copy
// lives in each section's footer.

private typealias F = WorkForm

private extension F.WhenType {
    /// The answer as a menu shows it: "Starts · On a schedule".
    var menuLabel: String {
        switch self {
        case .manual: return "Now"
        case .schedule: return "On a schedule"
        case .webhook: return "By webhook"
        case .ticket: return "From a ticket"
        case .github: return "GitHub event"
        case .slack: return "Slack message"
        case .linear: return "Linear event"
        }
    }
}

// MARK: - When

struct WhenSection: View {
    @Bindable var state: WorkFormState

    var body: some View {
        Section {
            MenuRow(label: "Starts", value: state.draft.when.menuLabel) {
                ForEach(F.WhenType.allCases, id: \.self) { w in
                    Button { state.setWhen(w) } label: {
                        Label(w.menuLabel, systemImage: w == state.draft.when ? "checkmark" : w.systemImage)
                    }
                }
            }
            switch state.draft.when {
            case .manual: EmptyView()
            case .schedule: scheduleRows
            case .webhook: webhookRows
            case .ticket: TicketRows(state: state)
            case .github, .slack, .linear: EventRows(state: state)
            }
        } header: {
            FormSectionHeader("When", question: "What starts it?", anchor: .when)
        } footer: {
            if let footer { Text(footer) }
        }
    }

    private var footer: String? {
        switch state.draft.when {
        case .manual: return nil
        case .schedule:
            let cron = state.draft.trigger.cronExpression ?? ""
            if !F.cronIsValid(cron) { return "Expected five space-separated fields." }
            if let words = F.cronWords[cron.trimmingCharacters(in: .whitespaces)] { return "Runs \(words)." }
            return "Five-field cron expression, in UTC."
        case .webhook: return "POST to this path to start a run. The path must be unique across the workspace."
        case .ticket: return "Only tickets with at least one matching label start a run. No labels matches every ticket from the source."
        case .github, .slack, .linear: return "Each firing starts one run — in a pod or on your machine, whichever you pick below — with the event's fields available as {{param}}s."
        }
    }

    @ViewBuilder
    private var scheduleRows: some View {
        ValueField(label: "Cron", placeholder: "0 9 * * *", text: Binding(
            get: { state.draft.trigger.cronExpression ?? "" },
            set: { v in state.edit { $0.trigger.cronExpression = v } }
        ))
        ChipRow(
            chips: F.cronPresets.map { Chip(value: $0.expr, label: $0.label) },
            selection: state.draft.trigger.cronExpression
        ) { expr in state.edit { $0.trigger.cronExpression = expr } }
    }

    private var webhookRows: some View {
        ValueField(label: "Path", placeholder: "hook-abc123", text: Binding(
            get: { state.draft.trigger.webhookPath ?? "" },
            set: { v in state.edit { $0.trigger.webhookPath = v.trimmingCharacters(in: .whitespaces) } }
        ), prefix: "/api/hooks/")
    }
}

private struct TicketRows: View {
    @Bindable var state: WorkFormState
    @State private var labelInput = ""

    private var labels: [String] { state.draft.trigger.ticketLabels ?? [] }
    private var source: F.TicketSource { state.draft.trigger.ticketSource ?? .github }

    var body: some View {
        MenuRow(label: "Source", value: source.label) {
            ForEach(F.TicketSource.allCases, id: \.self) { s in
                MenuChoice(title: s.label, selected: s == source) { state.edit { $0.trigger.ticketSource = s } }
            }
        }
        HStack(spacing: Spacing.s) {
            TextField("Add a label", text: $labelInput)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .onSubmit(addLabel)
            Button("Add", action: addLabel)
                .font(.body.weight(.medium))
                .disabled(labelInput.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        if !labels.isEmpty {
            FlowLayout(spacing: Spacing.s) {
                ForEach(labels, id: \.self) { l in
                    Button { state.edit { $0.trigger.ticketLabels = labels.filter { $0 != l } } } label: {
                        HStack(spacing: 4) {
                            Text(l).font(.footnote)
                            Image(systemName: "xmark").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, Spacing.m).padding(.vertical, 6)
                        .background(.fill.tertiary, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove \(l)")
                }
            }
            .padding(.vertical, 2)
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
private struct EventRows: View {
    @Bindable var state: WorkFormState

    private var type: F.EventTriggerType { state.draft.event.type }
    private var config: [String: AnyCodable] { state.draft.event.config }
    private var events: [String] { config["events"]?.arrayValue?.compactMap(\.stringValue) ?? [] }
    private var kinds: [F.EventKind] { type == .github ? F.githubKinds : type == .linear ? F.linearKinds : [] }
    private var personal: Bool { kinds.contains { $0.personal && events.contains($0.value) } }

    private func set(_ key: String, _ value: AnyCodable) {
        state.edit { $0.event.config[key] = value }
    }

    var body: some View {
        if type == .slack {
            ValueField(label: "Channel", placeholder: "C0123ABCD", text: Binding(
                get: { config["channelId"]?.stringValue ?? "" },
                set: { set("channelId", .string($0.trimmingCharacters(in: .whitespaces))) }
            ))
            Toggle("Only when @-mentioned", isOn: Binding(
                get: { config["mentionOnly"]?.boolValue ?? false },
                set: { set("mentionOnly", .bool($0)) }
            ))
        } else {
            ForEach(kinds, id: \.value) { k in
                Toggle(k.label, isOn: Binding(
                    get: { events.contains(k.value) },
                    set: { on in
                        let next = on ? events + [k.value] : events.filter { $0 != k.value }
                        set("events", .array(next.map { .string($0) }))
                    }
                ))
            }
            if personal {
                let key = type == .github ? "login" : "user"
                ValueField(
                    label: type == .github ? "GitHub username" : "Linear user",
                    placeholder: type == .github ? "octocat" : "Jane Doe",
                    text: Binding(
                        get: { config[key]?.stringValue ?? "" },
                        set: { v in set(key, .string(v.hasPrefix("@") ? String(v.dropFirst()) : v)) }
                    ),
                    mono: type == .github
                )
            }
        }
    }
}

// MARK: - Where

struct WhereSection: View {
    @Bindable var state: WorkFormState

    private var noHosts: Bool { !state.hostsLoading && state.hosts.isEmpty }
    private var dirs: [LocalHostDir] { state.host?.dirs ?? [] }

    var body: some View {
        let podDisabled = F.whereOptions(state.draft).first { $0.value == .cluster }?.disabled
        Section {
            ChoiceRow(
                systemImage: "server.rack",
                title: "Optio pod",
                subtitle: state.draft.withRepo ? "Clones one of your repos into a fresh worktree" : "Isolated, no checkout, with the server's Connections",
                selected: !state.isLocal,
                disabled: podDisabled
            ) { withAnimation(.snappy) { state.setWhere(.cluster) } }
            ChoiceRow(
                systemImage: "laptopcomputer",
                title: "My machine",
                subtitle: "A paired machine, with your own agent CLI and login",
                selected: state.isLocal,
                disabled: noHosts ? "No paired machine — run `optio local up` on your computer first."
                    : state.hostsLoading && state.hosts.isEmpty ? "Looking for paired machines…" : nil
            ) { withAnimation(.snappy) { state.setWhere(.local) } }

            if state.isLocal { machineRows } else { podRows }
        } header: {
            FormSectionHeader("Where", question: "A pod, or your machine?", anchor: .where)
        } footer: {
            if let footer { Text(footer) }
        }
    }

    private var footer: String? {
        if state.isLocal {
            if state.host?.state == .offline { return "This machine is offline — runs wait in the queue until it reconnects." }
            if !dirs.isEmpty, state.draft.withRepo, !dirs.contains(where: { $0.repoUrl != nil }) {
                return "None of this machine's directories is a git checkout — add one with `optio local add <checkout>`, or work in the current directory."
            }
            if state.draft.withRepo {
                if let repo = state.localRepoUrl { return "Branches off \(state.draft.repoBranch.isEmpty ? "the base branch" : state.draft.repoBranch) in \(F.shortRepo(repo)) and opens a PR against it." }
                return "The agent branches off the base branch in the checkout and opens a PR against it."
            }
            return "Works in the directory as it is, on whatever branch is checked out. Nothing is pushed unless you or the agent do it."
        }
        if !state.draft.withRepo { return "No checkout — results are logs and side effects through Connections." }
        if !state.reposLoading, state.repos.isEmpty { return "No repos configured. Add one under Library › Repos, or pick My machine." }
        return nil
    }

    // A machine: host + directory, then "Current directory | New branch".
    @ViewBuilder
    private var machineRows: some View {
        MenuRow(label: "Machine", value: state.host.map { $0.state == .offline ? "\($0.name) (offline)" : $0.name } ?? "Pick a machine…", placeholder: state.host == nil) {
            ForEach(state.hosts, id: \.id) { h in
                MenuChoice(title: h.name, subtitle: h.state == .offline ? "Offline" : nil, selected: h.id == state.draft.location.localHostId) { state.setHost(h.id) }
            }
        }
        MenuRow(
            label: state.draft.withRepo ? "Checkout" : "Directory",
            value: state.draft.location.localDir.isEmpty
                ? (dirs.isEmpty ? "No directories" : state.draft.withRepo ? "Pick a checkout…" : "Pick a directory…")
                : F.shortDir(state.draft.location.localDir),
            placeholder: state.draft.location.localDir.isEmpty,
            mono: true
        ) {
            if dirs.isEmpty {
                Text("Run `optio local add <dir>` on this machine.")
            }
            ForEach(dirs, id: \.path) { d in
                MenuChoice(title: F.shortDir(d.path), subtitle: state.usableDir(d) ? nil : "Not a git checkout", selected: d.path == state.draft.location.localDir) {
                    state.edit { $0.location.localDir = d.path }
                }
                .disabled(!state.usableDir(d))
            }
        }
        Picker("Mode", selection: Binding(get: { state.draft.withRepo }, set: { v in withAnimation(.snappy) { state.setWithRepo(v) } })) {
            Text("Current directory").tag(false)
            Text("New branch").tag(true)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .listRowInsets(EdgeInsets(top: Spacing.s, leading: Spacing.l, bottom: Spacing.s, trailing: Spacing.l))
        if state.draft.withRepo {
            ValueField(label: "Base branch", placeholder: "main", text: Binding(get: { state.draft.repoBranch }, set: { v in state.edit { $0.repoBranch = v } }))
        }
    }

    // A pod: "A repository | No repo", then repo + branch.
    @ViewBuilder
    private var podRows: some View {
        Picker("Repo", selection: Binding(get: { state.draft.withRepo }, set: { v in withAnimation(.snappy) { state.setWithRepo(v) } })) {
            Text("A repository").tag(true)
            Text("No repo").tag(false)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .listRowInsets(EdgeInsets(top: Spacing.s, leading: Spacing.l, bottom: Spacing.s, trailing: Spacing.l))
        if state.draft.withRepo {
            MenuRow(
                label: "Repository",
                value: state.reposLoading && state.repos.isEmpty ? "Loading…" : (state.repoRow?.fullName ?? (state.repos.isEmpty ? "None" : "Pick a repo…")),
                placeholder: state.repoRow == nil
            ) {
                ForEach(state.repos) { r in
                    MenuChoice(title: r.fullName, subtitle: r.defaultBranch, selected: r.id == state.draft.repoId) { state.setRepo(r.id) }
                }
            }
            ValueField(label: "Branch", placeholder: "main", text: Binding(get: { state.draft.repoBranch }, set: { v in state.edit { $0.repoBranch = v } }))
        }
    }
}

// MARK: - Who

struct WhoSection: View {
    @Bindable var state: WorkFormState

    private var runtimes: [F.Choice<String>] { F.runtimeOptions(state.draft) }

    private func name(_ runtime: String) -> String { runtime == F.terminal ? "Terminal" : F.runtimeLabel(runtime) }

    var body: some View {
        Section {
            MenuRow(label: "Runtime", value: name(state.draft.runtime)) {
                ForEach(runtimes, id: \.value) { r in
                    Button { state.setRuntime(r.value) } label: {
                        Label(name(r.value), systemImage: r.value == state.draft.runtime ? "checkmark" : r.value == F.terminal ? "terminal" : "cpu")
                        if let why = r.disabled { Text(why) }
                    }
                    .disabled(!r.isEnabled)
                }
            }
            if !state.isTerminal {
                AgentOptionsPickerView(
                    provider: state.provider,
                    state: state.catalogs.state(state.provider),
                    values: state.draft.agentOptions,
                    modelOnly: !state.fullOptionsApply,
                    onChange: state.setOption
                )
            }
        } header: {
            FormSectionHeader("Who", question: "A terminal, or an agent?", anchor: .who)
        } footer: {
            Text(footer)
        }
        .task(id: state.draft.runtime) { state.loadCatalog() }
        .onChange(of: state.catalogs.states.count) { _, _ in state.seedOptionsIfNeeded() }
    }

    private var footer: String {
        var lines: [String] = []
        if state.isTerminal {
            lines.append("Just you at a shell prompt — no agent, no prompt.")
        } else if state.isLocal {
            lines.append("Uses the CLI and login already on the machine; only the model is set here.")
        } else if state.draft.withRepo {
            lines.append("Runs with the server's credentials. Parameters start from the repo's defaults and apply to this run only.")
        } else {
            lines.append("Runs with the server's credentials. Blank means the runtime's default.")
        }
        let disabled = runtimes.filter { !$0.isEnabled }
        if let first = disabled.first {
            var why = first.disabled ?? ""
            if why.hasSuffix(".") { why.removeLast() }
            lines.append("\(disabled.map { name($0.value) }.joined(separator: ", ")) — \(why).")
        }
        if let note = AgentOptionsPickerView.footnote(state.catalogs.state(state.provider)) { lines.append(note) }
        return lines.joined(separator: " ")
    }
}

// MARK: - What

struct WhatSection: View {
    @Bindable var state: WorkFormState
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
        Section {
            PromptEditor(text: Binding(get: { state.draft.prompt }, set: { v in state.edit { $0.prompt = v } }), placeholder: placeholder, controller: editor)
            if !state.params.isEmpty {
                ChipRow(chips: state.params.map { Chip(value: $0, label: "{{\($0)}}") }, selection: nil, mono: true) { p in
                    state.edit { d in editor.insert("{{\(p)}}", into: &d.prompt) }
                }
            }
        } header: {
            FormSectionHeader("What", question: state.draft.then == .waitsForMessages ? "The first prompt" : "The prompt", anchor: .prompt) {
                if !state.templates.isEmpty {
                    Menu {
                        ForEach(state.templates) { t in
                            Button(t.name) { state.edit { $0.prompt = t.template ?? "" } }
                        }
                    } label: {
                        Label("Saved prompts", systemImage: "text.book.closed")
                            .font(.footnote.weight(.medium))
                            .imageScale(.small)
                            .foregroundStyle(AppTheme.accent)
                    }
                }
            }
        } footer: {
            if let footer { Text(footer) }
        }
    }

    private var footer: String? {
        if state.kind == .localTerminal { return "Optional for a terminal: typed into the shell once it opens." }
        switch state.draft.when {
        case .manual: return nil
        case .schedule: return "A schedule carries no parameters."
        case .webhook: return "Any top-level field of the POSTed JSON is available as {{field}}."
        default: return "Tap a parameter to insert it at the cursor."
        }
    }
}

// MARK: - Then

struct ThenSection: View {
    @Bindable var state: WorkFormState

    private func meta(_ then: F.Then) -> (icon: String, title: String, subtitle: String) {
        switch then {
        case .exits:
            return ("rectangle.portrait.and.arrow.right", "Exit when done",
                    state.draft.withRepo ? "One turn of work; opens the PR, then finishes" : "One turn of work, then the run finishes")
        case .waitsForMe:
            return ("terminal", "Wait for me", "Stops at its prompt after each turn until you type")
        case .waitsForMessages:
            return ("cpu", "Persistent agent", "Named, keeps its memory, wakes when messaged")
        }
    }

    var body: some View {
        Section {
            ForEach(F.thenOptions(state.draft), id: \.value) { c in
                let m = meta(c.value)
                ChoiceRow(systemImage: m.icon, title: m.title, subtitle: m.subtitle, selected: state.draft.then == c.value, disabled: c.disabled) {
                    withAnimation(.snappy) { state.setThen(c.value) }
                }
            }
            if state.draft.then == .waitsForMessages {
                MenuRow(label: "Pod lifecycle", value: state.draft.agent.podLifecycle.label) {
                    ForEach(F.PodLifecycle.allCases, id: \.self) { p in
                        MenuChoice(title: p.label, subtitle: p.hint, selected: p == state.draft.agent.podLifecycle) {
                            state.edit { $0.agent.podLifecycle = p }
                        }
                    }
                }
                TextField("System prompt — who is this agent?", text: Binding(get: { state.draft.agent.systemPrompt }, set: { v in state.edit { $0.agent.systemPrompt = v } }), axis: .vertical)
                    .lineLimit(2...8)
                TextField("Operator manual (agents.md)", text: Binding(get: { state.draft.agent.agentsMd }, set: { v in state.edit { $0.agent.agentsMd = v } }), axis: .vertical)
                    .font(.monoSubheadline)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .lineLimit(2...8)
            }
        } header: {
            FormSectionHeader("Then", question: "When a turn ends", anchor: .then)
        } footer: {
            if state.draft.then == .waitsForMessages {
                Text("\(state.draft.agent.podLifecycle.hint) The system prompt and manual are optional — a blank manual means Optio's standard one (messaging other agents, reading the inbox, finishing a turn).")
            } else if state.draft.then == .waitsForMe {
                Text("Interactive sessions land in your “needs you” queue whenever they stop.")
            }
        }
    }
}

// MARK: - Name (+ more)

struct NameSection: View {
    @Bindable var state: WorkFormState

    private var activeTasks: [TaskRow] { state.existingTasks.filter { !["completed", "cancelled"].contains($0.state) } }
    private var slugPlaceholder: String {
        F.slugify(state.draft.name.trimmingCharacters(in: .whitespaces).isEmpty ? state.autoName : state.draft.name)
    }

    var body: some View {
        Section {
            TextField("Name", text: Binding(get: { state.draft.name }, set: { v in state.edit { $0.name = v } }), prompt: Text(state.autoName))
                .textInputAutocapitalization(.sentences)
            if state.draft.then == .waitsForMessages {
                ValueField(label: "Address", placeholder: slugPlaceholder,
                           text: Binding(get: { state.draft.agent.slug }, set: { v in state.edit { $0.agent.slug = F.slugify(v) } }))
            }
        } header: {
            FormSectionHeader("Name", anchor: .name)
        } footer: {
            Text(footer)
        }

        Section {
            DisclosureGroup(isExpanded: $state.more) {
                TextField("Description", text: Binding(get: { state.draft.description }, set: { v in state.edit { $0.description = v } }), axis: .vertical)
                    .lineLimit(1...4)
                    .textInputAutocapitalization(.sentences)
                if state.draft.then == .exits {
                    if state.draft.withRepo {
                        Stepper(value: Binding(get: { state.draft.priority }, set: { v in state.edit { $0.priority = v } }), in: 1...1000, step: 10) {
                            LabeledContent("Priority", value: "\(state.draft.priority)")
                        }
                    }
                    Stepper(value: Binding(get: { state.draft.maxRetries }, set: { v in state.edit { $0.maxRetries = v } }), in: 0...10) {
                        LabeledContent("Max retries", value: "\(state.draft.maxRetries)")
                    }
                }
                if state.kind == .repoTask {
                    NavigationLink {
                        DependenciesPicker(state: state, tasks: activeTasks)
                    } label: {
                        LabeledContent("Wait for", value: state.draft.dependsOn.isEmpty ? "Nothing" : "\(state.draft.dependsOn.count) task\(state.draft.dependsOn.count == 1 ? "" : "s")")
                    }
                }
            } label: {
                Text("More options")
            }
        } footer: {
            if state.more, state.draft.then == .exits {
                Text(state.draft.withRepo ? "Lower priority runs sooner; 100 is the default." : "Failed runs retry with backoff, up to the limit.")
            }
        }
    }

    private var footer: String {
        var lines: [String] = []
        if state.draft.name.trimmingCharacters(in: .whitespaces).isEmpty {
            lines.append("Blank calls it “\(state.autoName)”.")
        } else if state.kind == .repoTask || state.kind == .repoBlueprint {
            lines.append("Also the title of the task that opens the PR.")
        }
        if state.draft.then == .waitsForMessages { lines.append("The address is how other agents message it.") }
        return lines.joined(separator: " ")
    }
}

/// Pick the tasks a Task waits on: a checklist pushed from "Wait for".
struct DependenciesPicker: View {
    @Bindable var state: WorkFormState
    let tasks: [TaskRow]

    var body: some View {
        List {
            if tasks.isEmpty {
                ContentUnavailableView("Nothing to wait on", systemImage: "link", description: Text("No other tasks are queued or running."))
            } else {
                Section {
                    ForEach(tasks.prefix(40)) { t in
                        let on = state.draft.dependsOn.contains(t.id)
                        Button {
                            state.edit { $0.dependsOn = on ? $0.dependsOn.filter { $0 != t.id } : $0.dependsOn + [t.id] }
                        } label: {
                            HStack(spacing: Spacing.m) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(t.title).font(.body).foregroundStyle(.primary).lineLimit(2)
                                    Text(t.state.replacingOccurrences(of: "_", with: " ")).font(.footnote).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if on { Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(AppTheme.accent) }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(on ? .isSelected : [])
                    }
                } footer: {
                    Text("This task starts only after every checked task completes.")
                }
            }
        }
        .navigationTitle("Wait for")
        .navigationBarTitleDisplayMode(.inline)
    }
}
