import SwiftUI
import Observation

@Observable @MainActor
final class ScheduledDetailModel {
    let id: String
    var config: TaskConfigRow?
    var triggers: [TriggerRow] = []
    var runs: [TaskRow] = []
    var error: Error?
    var actionError: Error?
    var notice: String?
    var busy = false

    init(id: String) { self.id = id }

    func load(api: APIClient) async {
        do {
            async let c = api.getTaskConfig(id)
            async let t = api.taskConfigTriggers(id)
            async let r = api.taskConfigRuns(id)
            config = try await c
            triggers = (try? await t) ?? []
            runs = (try? await r) ?? []
            error = nil
        } catch is CancellationError {
        } catch { self.error = error }
    }

    func run(api: APIClient, _ op: @escaping () async throws -> String?) async {
        busy = true
        defer { busy = false }
        do {
            if let msg = try await op() { notice = msg }
            await load(api: api)
        } catch { actionError = error }
    }
}

struct ScheduledDetailView: View {
    let configId: String
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var model: ScheduledDetailModel
    @State private var section = "config"
    @State private var showEdit = false
    @State private var showAddTrigger = false
    @State private var confirm: String?
    @State private var pendingTrigger: TriggerRow?

    init(configId: String) {
        self.configId = configId
        _model = State(initialValue: ScheduledDetailModel(id: configId))
    }

    var body: some View {
        Group {
            if let config = model.config {
                VStack(spacing: 0) {
                    DetailHeader(
                        state: config.enabled ? "active" : "paused",
                        tone: config.enabled ? .working : .idle,
                        line: Text.meta([
                            Text(RunFormatting.repoShortName(config.repoUrl)),
                            Text.mono(config.repoBranch ?? "main"),
                            Text(RunFormatting.agentLabel(config.agentType)),
                            Text(model.triggers.isEmpty ? "manual only" : "\(model.triggers.count) trigger\(model.triggers.count == 1 ? "" : "s")"),
                        ]),
                        secondary: model.triggers.first.map { Text(ScheduleFormat.humanize($0)) }
                    )
                    DetailTabs(options: [("config", "Config"), ("triggers", "Triggers"), ("runs", "Runs")], selection: $section)
                    switch section {
                    case "triggers": triggersList
                    case "runs": runsList
                    default: configList(config)
                    }
                }
                .navigationTitle(config.name)
            } else if let error = model.error {
                List { ErrorRow(error: error, what: "schedule") { Task { await model.load(api: api) } } }.listStyle(.plain)
            } else {
                List { SkeletonRows() }.listStyle(.plain)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Run now", systemImage: "play.fill") {
                        Task { await model.run(api: api) { "Task queued: \(try await api.runTaskConfig(configId).prefix(8))" } }
                    }
                    if let c = model.config {
                        Button(c.enabled ? "Pause" : "Resume", systemImage: c.enabled ? "pause" : "play") {
                            Task { await model.run(api: api) { try await api.setTaskConfigEnabled(configId, !c.enabled); return nil } }
                        }
                    }
                    Button("Edit", systemImage: "pencil") { showEdit = true }
                    Button("Add trigger", systemImage: "plus") { showAddTrigger = true }
                    Divider()
                    Button("Delete", systemImage: "trash", role: .destructive) { confirm = "delete" }
                } label: { if model.busy { ProgressView() } else { Image(systemName: "ellipsis.circle") } }
                .disabled(model.busy)
            }
        }
        .sheet(isPresented: $showEdit) { TaskConfigFormSheet(existing: model.config) { _ in Task { await model.load(api: api) } } }
        .sheet(isPresented: $showAddTrigger) { TriggerFormSheet(configId: configId) { Task { await model.load(api: api) } } }
        .confirmationDialog("Delete \"\(model.config?.name ?? "")\"? This removes all triggers.", isPresented: Binding(get: { confirm == "delete" }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task {
                    do { try await api.deleteTaskConfig(configId); dismiss() } catch { model.actionError = error }
                }
            }
        }
        .confirmationDialog("Delete \(pendingTrigger?.type ?? "") trigger?", isPresented: Binding(get: { pendingTrigger != nil }, set: { if !$0 { pendingTrigger = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                guard let t = pendingTrigger else { return }
                Task { await model.run(api: api) { try await api.deleteTaskConfigTrigger(configId, triggerId: t.id); return nil } }
            }
        }
        .errorToast(Binding(get: { model.actionError }, set: { model.actionError = $0 }))
        .toast(model.notice, tone: .success) { model.notice = nil }
        .task { await model.load(api: api) }
        .refreshable { await model.load(api: api) }
    }

    private func configList(_ c: TaskConfigRow) -> some View {
        List {
            Section {
                LabeledContent("Repository", value: RunFormatting.repoShortName(c.repoUrl))
                LabeledContent("Branch", value: c.repoBranch ?? "main")
                LabeledContent("Agent", value: RunFormatting.agentLabel(c.agentType))
                LabeledContent("Priority", value: "\(c.priority ?? 100)")
                LabeledContent("Max retries", value: "\(c.maxRetries ?? 3)")
            }
            if let d = c.description, !d.isEmpty { Section("Description") { Text(d) } }
            Section("Task title template") { Text(c.title) }
            Section("Prompt") { Text(c.prompt).font(.callout.monospaced()).textSelection(.enabled) }
        }
        .listStyle(.insetGrouped)
    }

    private var triggersList: some View {
        List {
            if model.triggers.isEmpty {
                Text("No triggers — this blueprint only runs when you tap Run now.").foregroundStyle(.secondary)
            }
            ForEach(model.triggers) { t in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Label(t.type.capitalized, systemImage: triggerIcon(t.type)).font(.body.weight(.medium))
                        Spacer()
                        Toggle("", isOn: Binding(get: { t.enabled }, set: { on in
                            Task { await model.run(api: api) { try await api.setTaskConfigTriggerEnabled(configId, triggerId: t.id, on); return nil } }
                        })).labelsHidden()
                    }
                    Text(t.summary).font(.caption.monospaced()).foregroundStyle(.secondary)
                    HStack(spacing: 10) {
                        if let n = t.nextFireAt { Text("Next: \(n.relativeDescription)") }
                        if let l = t.lastFiredAt { Text("Last: \(l.relativeDescription)") }
                    }
                    .font(.caption2).foregroundStyle(.tertiary)
                }
                .swipeActions { Button("Delete", role: .destructive) { pendingTrigger = t } }
            }
            Button("Add trigger", systemImage: "plus") { showAddTrigger = true }
        }
        .listStyle(.plain)
    }

    private var runsList: some View {
        List {
            if model.runs.isEmpty { Text("No runs yet.").foregroundStyle(.secondary) }
            ForEach(model.runs) { run in
                NavigationLink(value: run.id) { TaskRowView(task: run) }
            }
        }
        .listStyle(.plain)
        .navigationDestination(for: String.self) { id in TaskDetailView(taskId: id) }
    }
}

// MARK: - Create / edit sheet

struct TaskConfigFormSheet: View {
    var existing: TaskConfigRow?
    var onSaved: (TaskConfigRow) -> Void
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss

    @State private var repos: [RunRepoRow] = []
    @State private var templates: [RunPromptTemplateRow] = []
    @State private var name = ""
    @State private var description = ""
    @State private var title = ""
    @State private var prompt = ""
    @State private var repoUrl = ""
    @State private var branch = "main"
    @State private var agentType = ""
    @State private var templateId = ""
    @State private var priority = 100
    @State private var maxRetries = 3
    @State private var enabled = true
    @State private var saving = false
    @State private var error: Error?

    private var canSubmit: Bool {
        !saving && !name.trimmingCharacters(in: .whitespaces).isEmpty && !title.trimmingCharacters(in: .whitespaces).isEmpty && !prompt.trimmingCharacters(in: .whitespaces).isEmpty && !repoUrl.isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Blueprint") {
                    TextField("Name (e.g. Daily CVE patch)", text: $name)
                    TextField("Description", text: $description, axis: .vertical).lineLimit(1...3)
                    Toggle("Enabled", isOn: $enabled)
                }
                Section("Where") {
                    Picker("Repository", selection: $repoUrl) {
                        if repoUrl.isEmpty { Text("Select…").tag("") }
                        ForEach(repos) { r in Text(r.displayName).tag(r.repoUrl) }
                    }
                    .onChange(of: repoUrl) { _, url in
                        if let r = repos.first(where: { $0.repoUrl == url }), existing == nil { branch = r.defaultBranch ?? "main" }
                    }
                    TextField("Branch", text: $branch).autocorrectionDisabled().textInputAutocapitalization(.never)
                }
                Section("Who") {
                    Picker("Agent", selection: $agentType) {
                        Text("Repo default").tag("")
                        ForEach(RunFormatting.agentTypes, id: \.0) { Text($0.1).tag($0.0) }
                    }
                }
                Section {
                    TextField("Task title template", text: $title)
                    if !templates.isEmpty {
                        Picker("Prompt template", selection: $templateId) {
                            Text("None").tag("")
                            ForEach(templates) { t in Text(t.name).tag(t.id) }
                        }
                        .onChange(of: templateId) { _, id in
                            if let t = templates.first(where: { $0.id == id }) { prompt = t.template }
                        }
                    }
                    TextEditor(text: $prompt).frame(minHeight: 160)
                } header: { Text("What") } footer: { Text("{{param}} placeholders are filled from the trigger payload when the task is spawned.") }
                Section {
                    Stepper("Priority: \(priority)", value: $priority, in: 0...1000, step: 10)
                    Stepper("Max retries: \(maxRetries)", value: $maxRetries, in: 0...10)
                }
                if let error { ErrorRow(error: error) }
            }
            .navigationTitle(existing == nil ? "New scheduled task" : "Edit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { submit() } label: { if saving { ProgressView() } else { Text("Save") } }.disabled(!canSubmit)
                }
            }
            .task {
                if let e = existing {
                    name = e.name; description = e.description ?? ""; title = e.title; prompt = e.prompt
                    repoUrl = e.repoUrl; branch = e.repoBranch ?? "main"; agentType = e.agentType ?? ""
                    templateId = e.promptTemplateId ?? ""; priority = e.priority ?? 100; maxRetries = e.maxRetries ?? 3; enabled = e.enabled
                }
                repos = (try? await api.runListRepos()) ?? []
                if repoUrl.isEmpty, let first = repos.first { repoUrl = first.repoUrl; branch = first.defaultBranch ?? "main" }
                templates = (try? await api.runListPromptTemplates(kind: "task")) ?? []
            }
        }
    }

    private func submit() {
        saving = true
        Task {
            do {
                let saved: TaskConfigRow
                if let e = existing {
                    struct Patch: Encodable {
                        var name: String; var description: String?; var title: String; var prompt: String
                        var promptTemplateId: String?; var repoUrl: String; var repoBranch: String
                        var agentType: String?; var maxRetries: Int; var priority: Int; var enabled: Bool
                    }
                    saved = try await api.updateTaskConfig(e.id, Patch(
                        name: name, description: description.isEmpty ? nil : description, title: title, prompt: prompt,
                        promptTemplateId: templateId.isEmpty ? nil : templateId, repoUrl: repoUrl, repoBranch: branch,
                        agentType: agentType.isEmpty ? nil : agentType, maxRetries: maxRetries, priority: priority, enabled: enabled))
                } else {
                    saved = try await api.createTaskConfig(TaskConfigBody(
                        name: name, description: description.isEmpty ? nil : description, title: title, prompt: prompt,
                        promptTemplateId: templateId.isEmpty ? nil : templateId, repoUrl: repoUrl, repoBranch: branch,
                        agentType: agentType.isEmpty ? nil : agentType, maxRetries: maxRetries, priority: priority, enabled: enabled))
                }
                dismiss()
                onSaved(saved)
            } catch { self.error = error }
            saving = false
        }
    }
}

// MARK: - Trigger sheet (mirrors components/trigger-selector.tsx)

struct TriggerFormSheet: View {
    let configId: String
    var onSaved: () -> Void
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss

    @State private var type = "schedule"
    @State private var cron = "0 9 * * *"
    @State private var webhookPath = "hook-" + String(UUID().uuidString.lowercased().prefix(8))
    @State private var ticketSource = "github"
    @State private var labelsText = ""
    @State private var saving = false
    @State private var error: Error?

    static let cronPresets: [(String, String)] = [
        ("Every hour", "0 * * * *"), ("Every 6h", "0 */6 * * *"), ("Daily 09:00 UTC", "0 9 * * *"),
        ("Weekdays 09:00 UTC", "0 9 * * 1-5"), ("Mon 09:00 UTC", "0 9 * * 1"),
    ]

    private var cronValid: Bool { cron.trimmingCharacters(in: .whitespaces).split(separator: " ", omittingEmptySubsequences: true).count == 5 }
    private var canSubmit: Bool { !saving && (type != "schedule" || cronValid) && (type != "webhook" || !webhookPath.isEmpty) }

    var body: some View {
        NavigationStack {
            Form {
                Picker("Type", selection: $type) {
                    Label("Schedule", systemImage: "clock").tag("schedule")
                    Label("Webhook", systemImage: "link").tag("webhook")
                    Label("Ticket", systemImage: "ticket").tag("ticket")
                    Label("Manual", systemImage: "hand.tap").tag("manual")
                }
                .pickerStyle(.inline)
                switch type {
                case "schedule":
                    Section {
                        TextField("Cron expression", text: $cron).font(.body.monospaced()).autocorrectionDisabled().textInputAutocapitalization(.never)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack {
                                ForEach(Self.cronPresets, id: \.1) { p in
                                    Button(p.0) { cron = p.1 }.buttonStyle(.bordered).controlSize(.small)
                                }
                            }
                        }
                    } footer: {
                        Text(cronValid ? (Self.cronPresets.first { $0.1 == cron }.map { "Runs: \($0.0) (UTC)" } ?? "Five-field cron expression (UTC).") : "Expected five space-separated fields.")
                    }
                case "webhook":
                    Section { TextField("Path", text: $webhookPath).autocorrectionDisabled().textInputAutocapitalization(.never) } footer: { Text("POST /api/hooks/\(webhookPath) fires this trigger; the JSON body becomes {{params}}.") }
                case "ticket":
                    Section {
                        Picker("Source", selection: $ticketSource) {
                            ForEach(["github", "linear", "jira", "notion"], id: \.self) { Text($0.capitalized).tag($0) }
                        }
                        TextField("Labels (comma separated)", text: $labelsText)
                    } footer: { Text("Leave labels empty to accept all tickets from the source.") }
                default:
                    Text("Manual triggers only run when you tap Run now.").foregroundStyle(.secondary)
                }
                if let error { ErrorRow(error: error) }
            }
            .navigationTitle("Add trigger")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { submit() } label: { if saving { ProgressView() } else { Text("Add") } }.disabled(!canSubmit)
                }
            }
        }
    }

    private func submit() {
        saving = true
        var config: [String: AnyCodable] = [:]
        switch type {
        case "schedule": config["cronExpression"] = .string(cron.trimmingCharacters(in: .whitespaces))
        case "webhook": config["path"] = .string(webhookPath)
        case "ticket":
            config["source"] = .string(ticketSource)
            let labels = labelsText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            if !labels.isEmpty { config["labels"] = .array(labels.map { .string($0) }) }
        default: break
        }
        Task {
            do {
                try await api.createTaskConfigTrigger(configId, TriggerBody(type: type, config: config))
                dismiss(); onSaved()
            } catch { self.error = error }
            saving = false
        }
    }
}
