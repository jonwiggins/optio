import SwiftUI

/// Jobs list — standalone agent runs with no repo checkout. Mirrors
/// `/jobs` (StandaloneList): search, agent-type filter, stats strip, "Run now"
/// as a swipe action, and a "New Job" sheet. Embedded by the Run hub inside its
/// NavigationStack; declares its own navigation destinations.
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
            Section {
                if let stats = model.stats {
                    StatStrip(items: [
                        StatItem("Runs", stats.total),
                        StatItem("Running", stats.running),
                        StatItem("Completed", stats.completed),
                        StatItem("Failed", stats.failed, tone: .danger),
                    ])
                } else if !model.loaded {
                    SkeletonStrip(labels: ["Runs", "Running", "Completed", "Failed"])
                }
            }
            .listRowInsets(EdgeInsets(top: Spacing.xs, leading: Spacing.l, bottom: Spacing.xs, trailing: Spacing.l))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)

            Section {
                ChipPicker(options: [("", "All agents")] + JobFormat.agentRuntimes, selection: $agentFilter)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }

            if let error = model.error, model.jobs.isEmpty {
                ErrorRow(error: error, what: "jobs") { Task { await model.load(api) } }
            } else if !model.loaded {
                SkeletonRows()
            } else if filtered.isEmpty {
                EmptyState(
                    title: model.jobs.isEmpty ? "No jobs yet" : "No matching jobs",
                    systemImage: "bolt",
                    message: model.jobs.isEmpty ? "Run an agent with no repo checkout." : "Nothing matches this filter.",
                    actionTitle: model.jobs.isEmpty ? "New job" : nil,
                    action: { showNew = true }
                )
                .listRowSeparator(.hidden)
            } else {
                ForEach(filtered) { job in
                    NavigationLink(value: JobRoute.detail(job.id)) {
                        JobRow(job: job, running: model.runningId == job.id)
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        if job.isEnabled {
                            Button("Run now", systemImage: "play.fill") { Task { await model.runNow(job, api: api) } }.tint(AppTheme.accent)
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .animation(.snappy, value: agentFilter)
        .searchable(text: $query, prompt: "Search")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showNew = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New job")
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
        .refreshable { await model.load(api) }
        .task { await model.load(api) }
        .errorToast(Binding(get: { model.actionError }, set: { model.actionError = $0 }))
        .toast(model.toast, tone: .success) { model.toast = nil }
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
        guard job.isEnabled else { actionError = APIError(status: 0, message: "Job is paused", body: nil); return }
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

/// Job row: `runtime · model · last run 2h · 12 runs · $0.78`; "Paused" only when off.
struct JobRow: View {
    let job: JobSummary
    let running: Bool

    private var meta: Text? {
        Text.meta([
            JobFormat.runtimeLabel(job.runtime),
            job.model.flatMap { $0.isEmpty ? nil : $0 },
            job.lastRunAt.map { "last run \($0.relativeDescription)" } ?? "no runs yet",
            job.runCount.map { "\($0) run\($0 == 1 ? "" : "s")" },
            JobFormat.cost(job.totalCostUsd),
        ])
    }

    var body: some View {
        OptioRow(
            title: job.name,
            tone: running ? .working : nil,
            meta: meta,
            trailing: running ? "Starting…" : (job.isEnabled ? nil : "Paused"),
            footer: job.description.flatMap { $0.isEmpty ? nil : Text($0) }
        )
    }
}
