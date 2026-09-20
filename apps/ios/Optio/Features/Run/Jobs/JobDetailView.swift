import SwiftUI

/// Job detail — mirrors `/jobs/[id]`: stats bar, Runs / Triggers / Config
/// sections, and the Run / Edit / Duplicate / Enable-Disable / Delete actions.
struct JobDetailView: View {
    let jobId: String
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var model = JobDetailModel()
    @State private var section: Section = .runs
    @State private var runFilter = "all"
    @State private var showRun = false
    @State private var showEdit = false
    @State private var confirmDelete = false
    @State private var showPrompt = false

    enum Section: Hashable { case runs, triggers, config }

    var body: some View {
        Group {
            if let job = model.job {
                content(job)
            } else if let error = model.error {
                ErrorRow(error: error) { Task { await model.load(jobId, api: api) } }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationDestination(for: JobRoute.self) { route in
            switch route {
            case .detail(let id): JobDetailView(jobId: id)
            case .run(let jobId, let runId): JobRunDetailView(jobId: jobId, runId: runId)
            }
        }
        .navigationTitle(model.job?.name ?? "Job")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .task { await model.load(jobId, api: api) }
        .task(id: model.hasActiveRuns) {
            // Auto-refresh while runs are active (web polls every 5s).
            guard model.hasActiveRuns else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                await model.load(jobId, api: api, quiet: true)
            }
        }
        .sheet(isPresented: $showRun) {
            if let job = model.job {
                RunJobSheet(job: job) { _ in Task { await model.load(jobId, api: api, quiet: true) } }
            }
        }
        .sheet(isPresented: $showEdit) {
            if let job = model.job {
                JobFormView(mode: .edit(job, model.triggers)) { _ in Task { await model.load(jobId, api: api, quiet: true) } }
            }
        }
        .confirmationDialog("Delete this job and all its runs? This cannot be undone.", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete Job", role: .destructive) {
                Task { if await model.delete(jobId, api: api) { dismiss() } }
            }
        }
        .errorToast(Binding(get: { model.actionError }, set: { model.actionError = $0 }))
        .transientMessage(model.toast) { model.toast = nil }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Button {
                showRun = true
            } label: { Label("Run", systemImage: "play.fill") }
                .disabled(!(model.job?.isEnabled ?? false) || model.busy)
            Menu {
                Button { showEdit = true } label: { Label("Edit", systemImage: "pencil") }
                Button {
                    Task { await model.duplicate(jobId, api: api) }
                } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
                Button {
                    Task { await model.toggleEnabled(jobId, api: api) }
                } label: {
                    if model.job?.isEnabled ?? true {
                        Label("Disable", systemImage: "pause")
                    } else {
                        Label("Enable", systemImage: "play")
                    }
                }
                Button {
                    Task { await model.load(jobId, api: api, quiet: true) }
                } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                Divider()
                Button(role: .destructive) { confirmDelete = true } label: { Label("Delete", systemImage: "trash") }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .disabled(model.busy)
        }
    }

    @ViewBuilder
    private func content(_ job: JobSummary) -> some View {
        List {
            SwiftUI.Section {
                VStack(alignment: .leading, spacing: Spacing.s) {
                    DetailHeader(
                        state: job.isEnabled ? (model.activeRunCount > 0 ? "running" : "active") : "paused",
                        tone: job.isEnabled ? (model.activeRunCount > 0 ? .working : .idle) : .idle,
                        line: Text.meta([
                            JobFormat.runtimeLabel(job.runtime),
                            job.model.flatMap { $0.isEmpty ? nil : $0 },
                            job.lastRunAt.map { "last run \($0.relativeDescription)" } ?? "no runs yet",
                            model.activeRunCount > 0 ? "\(model.activeRunCount) active" : nil,
                        ]),
                        secondary: job.description.flatMap { $0.isEmpty ? nil : Text($0) }
                    )
                    .padding(.horizontal, -Spacing.l)
                    StatStrip(items: [
                        StatItem("Runs", job.runCount ?? model.runs.count),
                        StatItem("Success", text: model.successRateText),
                        StatItem("Cost", text: Cost.format(job.totalCostUsd)),
                    ])
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .listRowBackground(Color.clear)
            }

            SwiftUI.Section {
                DetailTabs(options: [
                    (Section.runs, "Runs"),
                    (Section.triggers, "Triggers"),
                    (Section.config, "Config"),
                ], selection: $section)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }

            switch section {
            case .runs: runsSection(job)
            case .triggers: triggersSection
            case .config: configSection(job)
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await model.load(jobId, api: api, quiet: true) }
    }

    // MARK: Runs

    private var filteredRuns: [JobRun] {
        switch runFilter {
        case "running": return model.runs.filter(\.isActive)
        case "all": return model.runs
        default: return model.runs.filter { $0.state == runFilter }
        }
    }

    @ViewBuilder
    private func runsSection(_ job: JobSummary) -> some View {
        if model.runs.isEmpty {
            SwiftUI.Section {
                VStack(spacing: 8) {
                    EmptyState(title: "No runs yet", systemImage: "circle.dotted", message: "Start your first run to see results here.")
                    Button { showRun = true } label: { Label("Run Now", systemImage: "play.fill") }
                        .buttonStyle(.borderedProminent)
                        .tint(AppTheme.accent)
                        .disabled(!job.isEnabled)
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
            }
        } else {
            SwiftUI.Section {
                ChipPicker(options: [
                    ("all", "All"),
                    ("running", "Running \(model.runs.filter(\.isActive).count)"),
                    ("completed", "Completed \(model.runs.filter { $0.state == "completed" }.count)"),
                    ("failed", "Failed \(model.runs.filter { $0.state == "failed" }.count)"),
                ], selection: $runFilter)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                if filteredRuns.isEmpty {
                    Text("No \(runFilter) runs").font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(filteredRuns) { run in
                    NavigationLink(value: JobRoute.run(jobId: jobId, runId: run.id)) {
                        JobRunRow(run: run)
                    }
                }
            }
        }
    }

    // MARK: Triggers

    @ViewBuilder
    private var triggersSection: some View {
        if model.triggers.isEmpty {
            SwiftUI.Section {
                VStack(spacing: 8) {
                    EmptyState(title: "No triggers configured", systemImage: "bolt", message: "Triggers define how this job is started (manually, on schedule, or via webhook).")
                    Button { showEdit = true } label: { Label("Configure Triggers", systemImage: "pencil") }
                        .buttonStyle(.bordered)
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
            }
        } else {
            SwiftUI.Section {
                ForEach(model.triggers) { trigger in
                    JobTriggerRow(trigger: trigger, serverURL: api.baseURL)
                }
            }
        }
    }

    // MARK: Config

    @ViewBuilder
    private func configSection(_ job: JobSummary) -> some View {
        SwiftUI.Section("Job Configuration") {
            LabeledContent("Agent Runtime", value: JobFormat.runtimeLabel(job.runtime))
            LabeledContent("Model", value: job.model ?? "Default")
            LabeledContent("Max Turns", value: job.maxTurns.map(String.init) ?? "Default")
            LabeledContent("Budget", value: job.budgetUsd.map { "$\($0)" } ?? "Unlimited")
            LabeledContent("Max Concurrent", value: "\(job.maxConcurrent ?? 2)")
            LabeledContent("Max Retries", value: "\(job.maxRetries ?? 1)")
            LabeledContent("Warm Pool", value: "\(job.warmPoolSize ?? 0)")
            LabeledContent("Max Pod Instances", value: "\(job.maxPodInstances ?? 1)")
            LabeledContent("Max Agents Per Pod", value: "\(job.maxAgentsPerPod ?? 2)")
            LabeledContent("Created", value: job.createdAt?.relativeDescription ?? "—")
            LabeledContent("Updated", value: job.updatedAt?.relativeDescription ?? "—")
        }
        if let schema = JobFormat.prettyJSON(job.paramsSchema) {
            SwiftUI.Section("Parameter Schema") {
                Text(schema).font(.caption.monospaced()).textSelection(.enabled)
            }
        }
        SwiftUI.Section {
            DisclosureGroup("Prompt Template", isExpanded: $showPrompt) {
                Text(job.promptTemplate ?? "")
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

struct JobRunRow: View {
    let run: JobRun

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                StatusBadge(text: run.state, tone: Tone.forState(run.state))
                Spacer()
                Text((run.startedAt ?? run.createdAt)?.relativeDescription ?? "")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                if let d = run.durationText { Label(d, systemImage: "clock") }
                if let m = run.modelUsed { Label(m, systemImage: "cpu") }
                if let c = JobFormat.cost(run.costUsd) { Label(c, systemImage: "dollarsign.circle") }
                if let t = run.tokensText { Label(t, systemImage: "text.word.spacing") }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            if let err = run.errorMessage, !err.isEmpty {
                Text(err).font(.caption2).foregroundStyle(.red).lineLimit(2)
            }
        }
    }
}

struct JobTriggerRow: View {
    let trigger: JobTrigger
    let serverURL: URL?

    private var webhookURL: String? {
        guard let path = trigger.webhookPath else { return nil }
        let base = serverURL?.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? ""
        return "\(base)/api/hooks/\(path)"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: JobFormat.triggerIcon(trigger.type))
                .frame(width: 32, height: 32)
                .background(.fill.tertiary, in: Radius.smallShape)
                .foregroundStyle((trigger.enabled ?? true) ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary))
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(trigger.type.capitalized).font(.subheadline.weight(.medium))
                    if !(trigger.enabled ?? true) { StatusBadge(text: "Paused", tone: .idle) }
                }
                if let cron = trigger.cronExpression {
                    Text(cron).font(.caption.monospaced())
                    if let next = trigger.nextFireAt {
                        Text("Next \(next.relativeDescription)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                if let url = webhookURL {
                    HStack(spacing: 6) {
                        Text(url).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                        Button {
                            UIPasteboard.general.string = url
                        } label: { Image(systemName: "doc.on.doc") }
                            .buttonStyle(.borderless)
                            .font(.caption)
                    }
                }
                if trigger.cronExpression == nil, trigger.webhookPath == nil, let cfg = JobFormat.prettyJSON(trigger.config) {
                    Text(cfg).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(3)
                }
                if let created = trigger.createdAt {
                    Text("Created \(created.relativeDescription)").font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

@Observable @MainActor
final class JobDetailModel {
    var job: JobSummary?
    var runs: [JobRun] = []
    var triggers: [JobTrigger] = []
    var error: Error?
    var actionError: Error?
    var busy = false
    var toast: String?

    var hasActiveRuns: Bool { runs.contains(where: \.isActive) }
    var activeRunCount: Int { runs.filter(\.isActive).count }
    var successRateText: String {
        guard !runs.isEmpty else { return "—" }
        let completed = runs.filter { $0.state == "completed" }.count
        return "\(Int((Double(completed) / Double(runs.count) * 100).rounded()))%"
    }

    func load(_ id: String, api: APIClient, quiet: Bool = false) async {
        do {
            async let job = api.getJob(id)
            async let runs = api.listJobRuns(id)
            async let triggers = api.listJobTriggers(id)
            self.job = try await job
            self.runs = try await runs
            self.triggers = (try? await triggers) ?? []
            error = nil
        } catch {
            if quiet { actionError = error } else { self.error = error }
        }
    }

    func toggleEnabled(_ id: String, api: APIClient) async {
        guard let job else { return }
        busy = true; defer { busy = false }
        do {
            self.job = try await api.setJobEnabled(id, enabled: !job.isEnabled)
            toast = job.isEnabled ? "Job disabled" : "Job enabled"
        } catch { actionError = error }
    }

    func duplicate(_ id: String, api: APIClient) async {
        busy = true; defer { busy = false }
        do {
            let clone = try await api.cloneJob(id)
            toast = "Duplicated as \(clone.name)"
        } catch { actionError = error }
    }

    func delete(_ id: String, api: APIClient) async -> Bool {
        busy = true; defer { busy = false }
        do { try await api.deleteJob(id); return true } catch { actionError = error; return false }
    }
}

enum JobRoute: Hashable {
    case detail(String)
    case run(jobId: String, runId: String)
}
