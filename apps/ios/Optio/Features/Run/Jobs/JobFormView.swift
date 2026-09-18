import SwiftUI

/// Create / edit sheet — mirrors `jobs/new` and `jobs/[id]/edit`
/// (WorkflowForm): name, description, enabled, agent runtime, model, limits,
/// prompt template with `{{PARAM}}` detection, and manual / schedule / webhook
/// triggers. Triggers are diffed on save the same way the web does.
struct JobFormView: View {
    enum Mode {
        case create
        case edit(JobSummary, [JobTrigger])
    }

    let mode: Mode
    var onSaved: (JobSummary) -> Void

    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var description = ""
    @State private var enabled = true
    @State private var agentRuntime = "claude-code"
    @State private var modelName = ""
    @State private var maxTurns = ""
    @State private var budgetUsd = ""
    @State private var maxConcurrent = 2
    @State private var maxRetries = 1
    @State private var warmPoolSize = 0
    @State private var maxPodInstances = 1
    @State private var maxAgentsPerPod = 2
    @State private var promptTemplate = ""
    @State private var triggers: [TriggerDraft] = []
    @State private var saving = false
    @State private var error: Error?
    @State private var initialized = false

    struct TriggerDraft: Identifiable {
        var id = UUID()
        var existingId: String?
        var originalType: String?
        var type = "manual"
        var cron = ""
        var path = ""
        var secret = ""
        var enabled = true
        var deleted = false

        var config: [String: AnyCodable] {
            switch type {
            case "schedule": return ["cronExpression": .string(cron)]
            case "webhook":
                var c: [String: AnyCodable] = ["path": .string(path)]
                if !secret.isEmpty { c["secret"] = .string(secret) }
                return c
            default: return [:]
            }
        }
    }

    private static let cronPresets: [(String, String)] = [
        ("Every hour", "0 * * * *"),
        ("Daily at midnight", "0 0 * * *"),
        ("Weekdays 9 AM", "0 9 * * 1-5"),
        ("Mondays 9 AM", "0 9 * * 1"),
        ("Every 6 hours", "0 */6 * * *"),
    ]

    private var isEdit: Bool { if case .edit = mode { return true } else { return false } }

    private var detectedParams: [String] {
        var seen: [String] = []
        let pattern = try? NSRegularExpression(pattern: "\\{\\{(\\w+)\\}\\}")
        let ns = promptTemplate as NSString
        for m in pattern?.matches(in: promptTemplate, range: NSRange(location: 0, length: ns.length)) ?? [] {
            let p = ns.substring(with: m.range(at: 1))
            if !seen.contains(p) { seen.append(p) }
        }
        return seen
    }

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
            && !promptTemplate.trimmingCharacters(in: .whitespaces).isEmpty
            && triggers.filter { !$0.deleted }.allSatisfy { t in
                (t.type != "schedule" || !t.cron.isEmpty) && (t.type != "webhook" || !t.path.isEmpty)
            }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Basics") {
                    TextField("Name", text: $name)
                        .autocorrectionDisabled()
                    TextField("Description (optional)", text: $description, axis: .vertical)
                        .lineLimit(1...3)
                    Toggle("Enabled", isOn: $enabled)
                }

                Section("Agent") {
                    Picker("Runtime", selection: $agentRuntime) {
                        ForEach(JobFormat.agentRuntimes, id: \.0) { value, label in Text(label).tag(value) }
                    }
                    TextField("Model (e.g. sonnet, opus)", text: $modelName)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    TextField("Max turns (default)", text: $maxTurns)
                        .keyboardType(.numberPad)
                    TextField("Budget USD (e.g. 5.00)", text: $budgetUsd)
                        .keyboardType(.decimalPad)
                }

                Section("Prompt Template") {
                    TextEditor(text: $promptTemplate)
                        .font(.body.monospaced())
                        .frame(minHeight: 140)
                    if promptTemplate.isEmpty {
                        Text("Use {{PARAM}} placeholders; they become run parameters.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else if !detectedParams.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Detected parameters").font(.caption).foregroundStyle(.secondary)
                            HStack { ForEach(detectedParams, id: \.self) { StatusBadge(text: $0, color: AppTheme.accent) } }
                        }
                    }
                }

                Section {
                    ForEach($triggers) { $t in
                        if !t.deleted { triggerEditor($t) }
                    }
                    Button { triggers.append(TriggerDraft()) } label: { Label("Add trigger", systemImage: "plus") }
                } header: {
                    Text("Triggers")
                } footer: {
                    Text("Manual triggers run on demand. Schedules use cron. Webhooks are reachable at /api/hooks/<path>.")
                }

                Section("Advanced") {
                    Stepper("Max concurrent: \(maxConcurrent)", value: $maxConcurrent, in: 1...50)
                    Stepper("Max retries: \(maxRetries)", value: $maxRetries, in: 0...10)
                    Stepper("Warm pool: \(warmPoolSize)", value: $warmPoolSize, in: 0...20)
                    Stepper("Pod instances: \(maxPodInstances)", value: $maxPodInstances, in: 1...20)
                    Stepper("Agents per pod: \(maxAgentsPerPod)", value: $maxAgentsPerPod, in: 1...50)
                }

                if let error {
                    Section { ErrorBanner(error: error) }
                }
            }
            .navigationTitle(isEdit ? "Edit Job" : "New Job")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        if saving { ProgressView() } else { Text(isEdit ? "Save" : "Create") }
                    }
                    .disabled(!canSave || saving)
                }
            }
            .onAppear(perform: seed)
            .interactiveDismissDisabled(saving)
        }
    }

    @ViewBuilder
    private func triggerEditor(_ t: Binding<TriggerDraft>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Picker("Type", selection: t.type) {
                    Text("Manual").tag("manual")
                    Text("Schedule").tag("schedule")
                    Text("Webhook").tag("webhook")
                }
                .pickerStyle(.segmented)
                Button(role: .destructive) {
                    if t.wrappedValue.existingId != nil { t.wrappedValue.deleted = true } else { triggers.removeAll { $0.id == t.wrappedValue.id } }
                } label: { Image(systemName: "trash") }
                    .buttonStyle(.borderless)
            }
            switch t.wrappedValue.type {
            case "schedule":
                TextField("Cron expression (0 9 * * 1-5)", text: t.cron)
                    .font(.body.monospaced())
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Self.cronPresets, id: \.1) { label, value in
                            Button(label) { t.wrappedValue.cron = value }
                                .buttonStyle(.bordered)
                                .controlSize(.mini)
                                .tint(t.wrappedValue.cron == value ? AppTheme.accent : .secondary)
                        }
                    }
                }
            case "webhook":
                TextField("Path (my-workflow-hook)", text: Binding(
                    get: { t.wrappedValue.path },
                    set: { t.wrappedValue.path = $0.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" } }
                ))
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                if !t.wrappedValue.path.isEmpty, let base = api.baseURL {
                    Text("\(base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/api/hooks/\(t.wrappedValue.path)")
                        .font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                TextField("HMAC secret (optional)", text: t.secret)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            default:
                EmptyView()
            }
            Toggle("Enabled", isOn: t.enabled).font(.subheadline)
        }
        .padding(.vertical, 4)
    }

    private func seed() {
        guard !initialized else { return }
        initialized = true
        guard case .edit(let job, let existing) = mode else { return }
        name = job.name
        description = job.description ?? ""
        enabled = job.isEnabled
        agentRuntime = job.runtime
        modelName = job.model ?? ""
        maxTurns = job.maxTurns.map(String.init) ?? ""
        budgetUsd = job.budgetUsd ?? ""
        maxConcurrent = job.maxConcurrent ?? 2
        maxRetries = job.maxRetries ?? 1
        warmPoolSize = job.warmPoolSize ?? 0
        maxPodInstances = job.maxPodInstances ?? 1
        maxAgentsPerPod = job.maxAgentsPerPod ?? 2
        promptTemplate = job.promptTemplate ?? ""
        triggers = existing.map { t in
            TriggerDraft(existingId: t.id, originalType: t.type, type: t.type, cron: t.cronExpression ?? "", path: t.webhookPath ?? "", secret: t.webhookSecret ?? "", enabled: t.enabled ?? true)
        }
    }

    /// Build `{ type: object, properties, required }` from `{{PARAM}}`s,
    /// preserving any existing per-param descriptions (web's buildParamsSchemaFromPrompt).
    private func paramsSchema() -> [String: AnyCodable]? {
        let detected = detectedParams
        var existingProps: [String: AnyCodable] = [:]
        if case .edit(let job, _) = mode { existingProps = job.paramsSchema?["properties"]?.objectValue ?? [:] }
        if detected.isEmpty {
            if case .edit(let job, _) = mode { return job.paramsSchema }
            return nil
        }
        var props: [String: AnyCodable] = [:]
        for p in detected {
            props[p] = existingProps[p] ?? .object(["type": .string("string"), "description": .string("")])
        }
        return ["type": .string("object"), "properties": .object(props), "required": .array(detected.map { .string($0) })]
    }

    private func save() async {
        saving = true
        error = nil
        defer { saving = false }
        let payload = JobPayload(
            name: name.trimmingCharacters(in: .whitespaces),
            description: description.isEmpty ? nil : description,
            enabled: enabled,
            promptTemplate: promptTemplate,
            agentRuntime: agentRuntime,
            model: modelName.isEmpty ? nil : modelName,
            maxTurns: Int(maxTurns),
            budgetUsd: budgetUsd.isEmpty ? nil : budgetUsd,
            maxConcurrent: maxConcurrent,
            maxRetries: maxRetries,
            warmPoolSize: warmPoolSize,
            maxPodInstances: maxPodInstances,
            maxAgentsPerPod: maxAgentsPerPod,
            paramsSchema: paramsSchema()
        )
        do {
            let saved: JobSummary
            switch mode {
            case .create: saved = try await api.createJob(payload)
            case .edit(let job, _): saved = try await api.updateJob(job.id, payload)
            }
            for t in triggers {
                if t.deleted {
                    if let id = t.existingId { try await api.deleteJobTrigger(saved.id, id) }
                } else if let id = t.existingId {
                    if t.type == t.originalType {
                        _ = try await api.updateJobTrigger(saved.id, id, config: t.config, enabled: t.enabled)
                    } else {
                        // The PATCH body has no `type`; a type change is delete + create.
                        try await api.deleteJobTrigger(saved.id, id)
                        _ = try await api.createJobTrigger(saved.id, TriggerPayload(type: t.type, config: t.config, enabled: t.enabled))
                    }
                } else {
                    _ = try await api.createJobTrigger(saved.id, TriggerPayload(type: t.type, config: t.config, enabled: t.enabled))
                }
            }
            onSaved(saved)
            dismiss()
        } catch {
            self.error = error
        }
    }
}
