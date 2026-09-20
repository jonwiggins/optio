import SwiftUI

/// Local Automations (`AutomationsSection` on the web's Machines page): reusable
/// agent / terminal specs plus the schedule / webhook / ticket / event triggers
/// that spawn them on one of your machines.
struct LocalBlueprintsView: View {
    var hosts: [LocalHost]

    @Environment(APIClient.self) private var api
    @State private var blueprints: [LocalBlueprint]?
    @State private var error: Error?
    @State private var actionError: String?
    @State private var showNew = false
    @State private var pendingDelete: LocalBlueprint?
    @State private var spawned: LocalTerminal?

    var body: some View {
        Group {
            if let blueprints {
                if blueprints.isEmpty {
                    ScrollView {
                        EmptyState(title: "No automations yet", systemImage: "square.stack.3d.up",
                                   message: "An automation runs an agent on your machine when something happens — a schedule, a webhook, a ticket, or a GitHub / Slack / Linear event.")
                            .frame(minHeight: 400)
                    }
                    .refreshable { await load() }
                } else {
                    List {
                        ForEach(blueprints, id: \.id) { bp in
                            NavigationLink(value: LocalRoute.blueprint(id: bp.id)) {
                                BlueprintRow(blueprint: bp)
                            }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) { pendingDelete = bp } label: { Label("Delete", systemImage: "trash") }
                            }
                            .swipeActions(edge: .leading) {
                                Button { Task { await spawn(bp) } } label: { Label("Spawn", systemImage: "play.fill") }.tint(AppTheme.accent)
                            }
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await load() }
                }
            } else if let error {
                ErrorRow(error: error) { Task { await load() } }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle("Automations")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showNew = true } label: { Image(systemName: "plus") }
            }
        }
        .task { await load() }
        .sheet(isPresented: $showNew) {
            BlueprintFormSheet(hosts: hosts, existing: nil) { bp in
                blueprints?.insert(bp, at: 0)
            }
        }
        .confirmationDialog("Delete automation \"\(pendingDelete?.name ?? "")\" and its triggers?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let bp = pendingDelete { Task { await delete(bp) } }
                pendingDelete = nil
            }
        }
        .alert("Spawned \"\(spawned?.title ?? "")\"", isPresented: Binding(get: { spawned != nil }, set: { if !$0 { spawned = nil } })) {
            Button("OK") { spawned = nil }
        } message: {
            Text(spawned.map { LocalPresentation.stateLabel($0) } ?? "")
        }
        .errorToast(Binding(get: { actionError }, set: { actionError = $0 }))
    }

    private func load() async {
        do { blueprints = try await api.listLocalBlueprints(); error = nil } catch { self.error = error }
    }

    private func spawn(_ bp: LocalBlueprint) async {
        do { spawned = try await api.spawnLocalBlueprint(bp.id) } catch { actionError = error.localizedDescription }
    }

    private func delete(_ bp: LocalBlueprint) async {
        do { try await api.deleteLocalBlueprint(bp.id); blueprints?.removeAll { $0.id == bp.id } } catch { actionError = error.localizedDescription }
    }
}

struct BlueprintRow: View {
    let blueprint: LocalBlueprint

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(blueprint.name).font(.subheadline.weight(.medium)).lineLimit(1)
                StatusBadge(text: blueprint.spawnMode.rawValue, tone: .working)
                if let agent = blueprint.agent {
                    StatusBadge(text: LocalPresentation.agentLabel(agent), tone: .accent)
                }
                Spacer()
                if !blueprint.enabled {
                    Text("disabled").font(.caption2).foregroundStyle(.tertiary)
                }
            }
            Text("\(blueprint.dir ?? blueprint.repoUrl ?? "any dir") · \(blueprint.commandTemplate)")
                .font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(2)
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Detail with triggers

struct LocalBlueprintDetailView: View {
    let blueprintId: String
    var hosts: [LocalHost]

    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var blueprint: LocalBlueprint?
    @State private var triggers: [LocalTrigger]?
    @State private var error: Error?
    @State private var actionError: String?
    @State private var showEdit = false
    @State private var showAddTrigger = false
    @State private var confirmDelete = false
    @State private var spawned: LocalTerminal?
    @State private var busy = false

    var body: some View {
        Group {
            if let bp = blueprint {
                List {
                    Section {
                        LabeledContent("Name", value: bp.name)
                        if let d = bp.description, !d.isEmpty { LabeledContent("Description", value: d) }
                        LabeledContent("Host", value: bp.hostId.flatMap { id in hosts.first { $0.id == id }?.name } ?? (bp.hostId ?? "Any online host"))
                        if let dir = bp.dir { LabeledContent("Directory") { Text(dir).font(.caption.monospaced()) } }
                        if let repo = bp.repoUrl { LabeledContent("Repo URL") { Text(repo).font(.caption.monospaced()) } }
                        LabeledContent(bp.agent == nil ? "Command template" : "Prompt template") {
                            Text(bp.commandTemplate).font(.caption.monospaced()).multilineTextAlignment(.trailing)
                        }
                        LabeledContent("Run as", value: bp.agent.map(LocalPresentation.agentLabel) ?? "Shell")
                        LabeledContent("Spawn mode", value: bp.spawnMode == .hold ? "hold — create pending, start with one tap" : "auto — spawn immediately")
                        Toggle("Enabled", isOn: Binding(get: { bp.enabled }, set: { v in Task { await setEnabled(v) } }))
                    }

                    Section {
                        if let triggers {
                            if triggers.isEmpty {
                                Text("No triggers — spawn manually or add one.").font(.footnote).foregroundStyle(.secondary)
                            }
                            ForEach(triggers) { t in
                                HStack(spacing: 8) {
                                    Image(systemName: t.systemImage).foregroundStyle(.secondary).frame(width: 18)
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack(spacing: 6) {
                                            Text(t.type.capitalized).font(.caption.weight(.semibold))
                                            if !t.enabled { Text("disabled").font(.caption2).foregroundStyle(.tertiary) }
                                        }
                                        Text(t.summary).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(2)
                                        if let next = t.nextFireAt { Text("next \(next.relativeDescription)").font(.caption2).foregroundStyle(.tertiary) }
                                    }
                                }
                                .swipeActions {
                                    Button(role: .destructive) { Task { await deleteTrigger(t) } } label: { Label("Delete", systemImage: "trash") }
                                }
                            }
                        } else {
                            ProgressView()
                        }
                        Button { showAddTrigger = true } label: { Label("Add trigger", systemImage: "plus") }
                    } header: {
                        Text("Triggers")
                    }

                    Section {
                        Button { Task { await spawn() } } label: { Label("Spawn terminal now", systemImage: "play.fill") }
                        Button(role: .destructive) { confirmDelete = true } label: { Label("Delete blueprint", systemImage: "trash") }
                    }
                }
                .refreshable { await load() }
            } else if let error {
                ErrorRow(error: error) { Task { await load() } }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(blueprint?.name ?? "Blueprint")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Edit") { showEdit = true }.disabled(blueprint == nil || busy)
            }
        }
        .task { await load() }
        .sheet(isPresented: $showEdit) {
            if let blueprint {
                BlueprintFormSheet(hosts: hosts, existing: blueprint) { updated in self.blueprint = updated }
            }
        }
        .sheet(isPresented: $showAddTrigger) {
            AddTriggerSheet(blueprintId: blueprintId, serverURL: api.baseURL) { t in triggers?.append(t) }
        }
        .confirmationDialog("Delete blueprint \"\(blueprint?.name ?? "")\" and its triggers?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await deleteBlueprint() } }
        }
        .alert("Spawned \"\(spawned?.title ?? "")\"", isPresented: Binding(get: { spawned != nil }, set: { if !$0 { spawned = nil } })) {
            Button("OK") { spawned = nil }
        } message: {
            Text(spawned.map { LocalPresentation.stateLabel($0) } ?? "")
        }
        .errorToast(Binding(get: { actionError }, set: { actionError = $0 }))
    }

    private func load() async {
        do {
            async let bp = api.getLocalBlueprint(blueprintId)
            async let tr = api.listLocalBlueprintTriggers(blueprintId)
            let (b, t) = try await (bp, tr)
            blueprint = b
            triggers = t
            error = nil
        } catch {
            if blueprint == nil { self.error = error } else { actionError = error.localizedDescription }
        }
    }

    private func setEnabled(_ v: Bool) async {
        busy = true
        do { blueprint = try await api.updateLocalBlueprint(blueprintId, LocalBlueprintBody(enabled: v)) } catch { actionError = error.localizedDescription }
        busy = false
    }

    private func spawn() async {
        do { spawned = try await api.spawnLocalBlueprint(blueprintId) } catch { actionError = error.localizedDescription }
    }

    private func deleteBlueprint() async {
        do { try await api.deleteLocalBlueprint(blueprintId); dismiss() } catch { actionError = error.localizedDescription }
    }

    private func deleteTrigger(_ t: LocalTrigger) async {
        do { try await api.deleteLocalBlueprintTrigger(blueprintId, triggerId: t.id); triggers?.removeAll { $0.id == t.id } } catch { actionError = error.localizedDescription }
    }
}

// MARK: - Create / edit sheet

struct BlueprintFormSheet: View {
    var hosts: [LocalHost]
    var existing: LocalBlueprint?
    var onSaved: (LocalBlueprint) -> Void

    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var hostId = ""
    @State private var useRepoUrl = false
    @State private var dir = ""
    @State private var repoUrl = ""
    @State private var commandTemplate = ""
    @State private var agent: LocalAgentKind?
    @State private var spawnMode: LocalBlueprintSpawnMode = .hold
    @State private var saving = false
    @State private var error: String?

    private var host: LocalHost? { hosts.first { $0.id == hostId } }
    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
            && !commandTemplate.trimmingCharacters(in: .whitespaces).isEmpty
            && !(useRepoUrl ? repoUrl : dir).trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name, e.g. triage ticket", text: $name)
                    TextField("Description (optional)", text: $description)
                    Picker("Host", selection: $hostId) {
                        Text("Any online host").tag("")
                        ForEach(hosts, id: \.id) { Text($0.name).tag($0.id) }
                    }
                    .onChange(of: hostId) { _, _ in dir = "" }
                }

                Section("Location") {
                    Picker("Resolve by", selection: $useRepoUrl) {
                        Text("Directory").tag(false)
                        Text("Repo URL").tag(true)
                    }
                    .pickerStyle(.segmented)
                    if useRepoUrl {
                        TextField("https://github.com/owner/repo", text: $repoUrl)
                            .font(.body.monospaced()).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Text("Resolved against the host's dir list.").font(.caption).foregroundStyle(.secondary)
                    } else if let host, !host.dirs.isEmpty {
                        Picker("Directory", selection: $dir) {
                            Text("Pick a directory…").tag("")
                            ForEach(host.dirs, id: \.path) { Text($0.path).font(.caption.monospaced()).tag($0.path) }
                        }
                        .pickerStyle(.navigationLink)
                    } else {
                        TextField("/absolute/path/on/the/host", text: $dir)
                            .font(.body.monospaced()).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                }

                Section {
                    Picker("Run as agent", selection: $agent) {
                        Text("None (shell)").tag(LocalAgentKind?.none)
                        ForEach(LocalAgentKind.allCases, id: \.self) { a in
                            Text(LocalPresentation.agentLabel(a)).tag(LocalAgentKind?.some(a))
                        }
                    }
                    TextField(agent == nil ? "claude {{prompt}}" : "Investigate {{ticketTitle}}", text: $commandTemplate, axis: .vertical)
                        .font(.body.monospaced()).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .lineLimit(2...6)
                    if let agent {
                        Text("The template renders as \(LocalPresentation.agentLabel(agent))'s prompt. Params are substituted plainly (not shell-quoted): write {{ticketTitle}} as-is.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("Runs as a raw shell command. Params are pre-shell-quoted: write `claude {{prompt}}`, not `claude \"{{prompt}}\"`.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } header: {
                    Text(agent == nil ? "Command template" : "Prompt template")
                }

                Section("Spawn mode") {
                    Picker("Spawn mode", selection: $spawnMode) {
                        Text("hold — create pending, start with one tap").tag(LocalBlueprintSpawnMode.hold)
                        Text("auto — spawn immediately").tag(LocalBlueprintSpawnMode.auto)
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }

                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle(existing == nil ? "New Blueprint" : "Edit Blueprint")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: { if saving { ProgressView() } else { Text(existing == nil ? "Create" : "Save") } }
                        .disabled(!canSave || saving)
                }
            }
            .onAppear {
                guard let e = existing else { return }
                name = e.name
                description = e.description ?? ""
                hostId = e.hostId ?? ""
                useRepoUrl = e.dir == nil && e.repoUrl != nil
                dir = e.dir ?? ""
                repoUrl = e.repoUrl ?? ""
                commandTemplate = e.commandTemplate
                agent = e.agent
                spawnMode = e.spawnMode == .unknown ? .hold : e.spawnMode
            }
        }
    }

    private func save() async {
        saving = true
        error = nil
        let body = LocalBlueprintBody(
            name: name.trimmingCharacters(in: .whitespaces),
            description: description.trimmingCharacters(in: .whitespaces).isEmpty ? nil : description,
            hostId: hostId.isEmpty ? nil : hostId,
            dir: useRepoUrl ? nil : dir.trimmingCharacters(in: .whitespaces),
            repoUrl: useRepoUrl ? repoUrl.trimmingCharacters(in: .whitespaces) : nil,
            commandTemplate: commandTemplate.trimmingCharacters(in: .whitespacesAndNewlines),
            agent: agent,
            clearAgent: existing != nil && agent == nil,
            spawnMode: spawnMode
        )
        do {
            let saved: LocalBlueprint
            if let existing {
                saved = try await api.updateLocalBlueprint(existing.id, body)
            } else {
                saved = try await api.createLocalBlueprint(body)
            }
            onSaved(saved)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
        saving = false
    }
}

// MARK: - Add trigger sheet

struct AddTriggerSheet: View {
    let blueprintId: String
    var serverURL: URL?
    var onCreated: (LocalTrigger) -> Void

    private static let ticketSources = ["github", "gitlab", "linear", "jira", "notion"]

    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var type = "schedule"
    @State private var cron = "0 9 * * *"
    @State private var path = "local-" + String(UUID().uuidString.lowercased().prefix(8))
    @State private var source = "github"
    @State private var labels = ""
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Picker("Type", selection: $type) {
                    Text("Schedule").tag("schedule")
                    Text("Webhook").tag("webhook")
                    Text("Ticket").tag("ticket")
                }
                .pickerStyle(.segmented)

                switch type {
                case "schedule":
                    Section("Cron expression") {
                        TextField("0 9 * * *", text: $cron).font(.body.monospaced()).autocorrectionDisabled()
                        Text("Five space-separated fields.").font(.caption).foregroundStyle(.secondary)
                    }
                case "webhook":
                    Section("Webhook path") {
                        TextField("my-hook-path", text: $path).font(.body.monospaced()).textInputAutocapitalization(.never).autocorrectionDisabled()
                        if let base = serverURL, !path.trimmingCharacters(in: .whitespaces).isEmpty {
                            Text("POST \(base.absoluteString)/api/hooks/\(path.trimmingCharacters(in: .whitespaces))")
                                .font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                    }
                default:
                    Section("Ticket") {
                        Picker("Source", selection: $source) {
                            ForEach(Self.ticketSources, id: \.self) { Text($0).tag($0) }
                        }
                        TextField("labels, comma-separated (optional)", text: $labels).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                }

                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle("Add Trigger")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await create() } } label: { if saving { ProgressView() } else { Text("Add") } }.disabled(saving)
                }
            }
        }
    }

    private func create() async {
        var config: [String: AnyCodable]
        switch type {
        case "schedule":
            let c = cron.trimmingCharacters(in: .whitespaces)
            guard c.split(separator: " ").count == 5 else { error = "Cron expression needs five space-separated fields"; return }
            config = ["cronExpression": .string(c)]
        case "webhook":
            let p = path.trimmingCharacters(in: .whitespaces)
            guard !p.isEmpty else { error = "Webhook path is required"; return }
            config = ["path": .string(p)]
        default:
            config = ["source": .string(source)]
            let list = labels.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            if !list.isEmpty { config["labels"] = .array(list.map { .string($0) }) }
        }
        saving = true
        error = nil
        do {
            let t = try await api.createLocalBlueprintTrigger(blueprintId, CreateLocalTriggerBody(type: type, config: config))
            onCreated(t)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
        saving = false
    }
}
