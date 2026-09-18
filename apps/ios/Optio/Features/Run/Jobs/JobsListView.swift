import SwiftUI

/// Jobs list — standalone agent runs with no repo checkout. Mirrors
/// `/jobs` (StandaloneList): search, agent-type filter, stats bar, "Run now",
/// and a "New Job" sheet. Designed to be embedded by the Run hub inside its
/// NavigationStack; it declares its own navigation destinations.
struct JobsListView: View {
    @Environment(APIClient.self) private var api
    @State private var model = JobsListModel()
    @State private var showNew = false
    @State private var query = ""
    @State private var agentFilter = ""

    private var filtered: [JobSummary] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return model.jobs.filter { job in
            if !agentFilter.isEmpty, job.runtime != agentFilter { return false }
            if q.isEmpty { return true }
            return job.name.lowercased().contains(q) || (job.description?.lowercased().contains(q) ?? false)
        }
    }

    var body: some View {
        List {
            if let stats = model.stats {
                Section {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                        StatTile(title: "Runs", value: "\(stats.total)", systemImage: "number")
                        StatTile(title: "Running", value: "\(stats.running)", color: .blue, systemImage: "play.circle")
                        StatTile(title: "Completed", value: "\(stats.completed)", color: .green, systemImage: "checkmark.circle")
                        StatTile(title: "Failed", value: "\(stats.failed)", color: .red, systemImage: "xmark.circle")
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
            }

            Section {
                ChipPicker(options: [("", "All agents")] + JobFormat.agentRuntimes, selection: $agentFilter)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            if let error = model.error, model.jobs.isEmpty {
                ErrorBanner(error: error) { Task { await model.load(api) } }
            } else if model.loaded && filtered.isEmpty {
                EmptyState(
                    title: model.jobs.isEmpty ? "No jobs yet" : "No matching jobs",
                    systemImage: "bolt",
                    message: model.jobs.isEmpty ? "Create a job to run an agent with no repo checkout." : nil
                )
            } else {
                ForEach(filtered) { job in
                    NavigationLink(value: JobRoute.detail(job.id)) {
                        JobRow(job: job, running: model.runningId == job.id) {
                            Task { await model.runNow(job, api: api) }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .searchable(text: $query, prompt: "Search jobs")
        .navigationTitle("Jobs")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showNew = true } label: { Image(systemName: "plus") }
            }
        }
        .sheet(isPresented: $showNew) {
            JobFormView(mode: .create) { _ in Task { await model.load(api) } }
        }
        .navigationDestination(for: JobRoute.self) { route in
            switch route {
            case .detail(let id): JobDetailView(jobId: id)
            case .run(let jobId, let runId): JobRunDetailView(jobId: jobId, runId: runId)
            }
        }
        .overlay {
            if !model.loaded && model.error == nil { ProgressView() }
        }
        .refreshable { await model.load(api) }
        .task { await model.load(api) }
        .alert("Error", isPresented: Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.actionError?.localizedDescription ?? "")
        }
        .transientMessage(model.toast) { model.toast = nil }
    }
}

enum JobRoute: Hashable {
    case detail(String)
    case run(jobId: String, runId: String)
}

@Observable @MainActor
final class JobsListModel {
    var jobs: [JobSummary] = []
    var stats: JobStats?
    var loaded = false
    var error: Error?
    var actionError: Error?
    var runningId: String?
    var toast: String?

    func load(_ api: APIClient) async {
        do {
            async let jobs = api.listJobs()
            async let stats = api.standaloneJobStats()
            self.jobs = try await jobs
            self.stats = try? await stats
            error = nil
        } catch {
            self.error = error
        }
        loaded = true
    }

    func runNow(_ job: JobSummary, api: APIClient) async {
        guard job.isEnabled else { actionError = APIError(status: 0, message: "Job is disabled", body: nil); return }
        runningId = job.id
        defer { runningId = nil }
        do {
            let run = try await api.runJob(job.id, params: nil)
            toast = "Run \(run.id.prefix(8)) started"
            await load(api)
        } catch {
            actionError = error
        }
    }
}

struct JobRow: View {
    let job: JobSummary
    let running: Bool
    let onRun: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(job.name).font(.headline).lineLimit(1)
                    if let d = job.description, !d.isEmpty {
                        Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                Spacer()
                StatusBadge(text: job.isEnabled ? "Active" : "Off", color: job.isEnabled ? .green : .gray)
            }
            HStack(spacing: 6) {
                Text(JobFormat.runtimeLabel(job.runtime))
                if let m = job.model, !m.isEmpty { Text("·"); Text(m) }
                ForEach(job.triggerTypes ?? [], id: \.self) { t in
                    Image(systemName: JobFormat.triggerIcon(t))
                }
                if let cost = JobFormat.cost(job.totalCostUsd) { Text("·"); Text(cost) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            HStack {
                Text(job.lastRunAt.map { "Last run \($0.relativeDescription)" } ?? "No runs yet")
                Text("·")
                Text("\(job.runCount ?? 0) run\(job.runCount == 1 ? "" : "s")")
                Spacer()
                Button {
                    onRun()
                } label: {
                    if running { ProgressView().controlSize(.mini) } else { Label("Run now", systemImage: "play.circle") }
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .tint(AppTheme.accent)
                .disabled(!job.isEnabled || running)
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Toast helper (sonner-style transient confirmation)

struct TransientMessageModifier: ViewModifier {
    let message: String?
    let dismiss: () -> Void

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if let message {
                Text(message)
                    .font(.footnote.weight(.medium))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, 12)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task {
                        try? await Task.sleep(for: .seconds(2.5))
                        dismiss()
                    }
            }
        }
        .animation(.easeInOut, value: message)
    }
}

extension View {
    func transientMessage(_ message: String?, dismiss: @escaping () -> Void) -> some View {
        modifier(TransientMessageModifier(message: message, dismiss: dismiss))
    }
}
