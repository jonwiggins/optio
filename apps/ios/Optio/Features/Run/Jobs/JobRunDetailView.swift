import SwiftUI

/// Job run detail — mirrors `/jobs/[id]/runs/[runId]`: state, timing, cost,
/// params/output, error, live logs (REST catch-up + `/ws/workflow-runs/:id/logs`),
/// and Cancel / Retry.
struct JobRunDetailView: View {
    let jobId: String
    let runId: String
    @Environment(APIClient.self) private var api
    @State private var model = JobRunDetailModel()
    @State private var logs = RunLogStream(logEventType: "workflow_run:log", stateEventTypes: ["workflow_run:state_changed"])
    @State private var section: Section = .logs
    @State private var confirmCancel = false

    enum Section: Hashable { case logs, details }

    var body: some View {
        VStack(spacing: 0) {
            if let run = model.run {
                header(run)
                DetailTabs(options: [(Section.logs, "Logs"), (Section.details, "Details")], selection: $section)
                switch section {
                case .logs:
                    if logs.entries.isEmpty {
                        VStack(spacing: 8) {
                            if run.isActive { ProgressView() }
                            Text(run.isActive ? "Waiting for output…" : "No logs recorded").foregroundStyle(.secondary).font(.footnote)
                            if let e = logs.error { Text(e.localizedDescription).font(.caption).foregroundStyle(.red) }
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        AgentLogView(entries: logs.entries)
                    }
                case .details:
                    details(run)
                }
            } else if let error = model.error {
                List { ErrorRow(error: error, what: "run") { Task { await model.load(runId, jobId: jobId, api: api) } } }.listStyle(.plain)
            } else {
                List { SkeletonRows() }.listStyle(.plain)
            }
        }
        .navigationTitle(model.jobName ?? "Run \(runId.prefix(8))")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if model.run?.canRetry == true {
                    Button { Task { await model.retry(runId, api: api) } } label: { Label("Retry", systemImage: "arrow.counterclockwise") }
                        .disabled(model.busy)
                }
                if model.run?.canCancel == true {
                    Button(role: .destructive) { confirmCancel = true } label: { Label("Cancel", systemImage: "stop.circle") }
                        .disabled(model.busy)
                }
                Button { Task { await model.load(runId, jobId: jobId, api: api) } } label: { Image(systemName: "arrow.clockwise") }
            }
        }
        .confirmationDialog("Cancel this run?", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Cancel Run", role: .destructive) { Task { await model.cancel(runId, api: api) } }
        }
        .task {
            await model.load(runId, jobId: jobId, api: api)
            logs.onStateChanged = { Task { await model.load(runId, jobId: jobId, api: api) } }
            logs.start(api: api, wsPath: "/ws/workflow-runs/\(runId)/logs") { try await api.jobRunLogs(runId) }
        }
        .task(id: model.run?.isActive) {
            guard model.run?.isActive == true else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                await model.load(runId, jobId: jobId, api: api)
            }
        }
        .onDisappear { logs.stop() }
        .errorToast(Binding(get: { model.actionError }, set: { model.actionError = $0 }))
    }

    private func header(_ run: JobRun) -> some View {
        DetailHeader(
            state: run.state,
            line: Text.meta([
                run.durationText.map { Text($0) } ?? run.createdAt.map { Text($0.relativeDescription) },
                run.modelUsed.map { Text(InsightsFormat.modelShortName($0)) },
                Cost.formatIfNonZero(run.costUsd).map { Text($0) },
                run.tokensText.map { Text($0) },
                (run.retryCount ?? 0) > 0 ? Text("retry \(run.retryCount!)") : nil,
                Text.mono(String(runId.prefix(8))),
            ]),
            secondary: run.errorMessage.flatMap { $0.isEmpty ? nil : Text($0) }
        ) {
            if logs.connected { StateDot(tone: .working, size: 6).accessibilityLabel("Live") }
        }
    }

    private func details(_ run: JobRun) -> some View {
        List {
            SwiftUI.Section("Run") {
                LabeledContent("State", value: run.state)
                LabeledContent("Created", value: run.createdAt?.formatted(date: .abbreviated, time: .shortened) ?? "—")
                LabeledContent("Started", value: run.startedAt?.formatted(date: .abbreviated, time: .shortened) ?? "—")
                LabeledContent("Finished", value: run.finishedAt?.formatted(date: .abbreviated, time: .shortened) ?? "—")
                LabeledContent("Duration", value: run.durationText ?? "—")
                LabeledContent("Model", value: run.modelUsed ?? "—")
                LabeledContent("Cost", value: JobFormat.cost(run.costUsd, digits: 4) ?? "—")
                LabeledContent("Tokens (in / out)", value: run.tokensText ?? "—")
                LabeledContent("Retries", value: "\(run.retryCount ?? 0)")
                if let pod = run.podName { LabeledContent("Pod", value: pod) }
                if let s = run.sessionId { LabeledContent("Session", value: s) }
            }
            if let params = run.params, !params.isEmpty {
                SwiftUI.Section("Parameters (\(params.count))") {
                    ForEach(params.keys.sorted(), id: \.self) { key in
                        LabeledContent(key) {
                            Text(params[key].map(Self.describe) ?? "").font(.caption.monospaced()).multilineTextAlignment(.trailing)
                        }
                    }
                }
            }
            if let output = JobFormat.prettyJSON(run.output) {
                SwiftUI.Section("Output") {
                    Text(output).font(.caption.monospaced()).textSelection(.enabled)
                }
            }
            if let err = run.errorMessage, !err.isEmpty {
                SwiftUI.Section("Error") {
                    Text(err).font(.caption.monospaced()).foregroundStyle(.red).textSelection(.enabled)
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private static func describe(_ v: AnyCodable) -> String {
        if let s = v.stringValue { return s }
        if let b = v.boolValue { return b ? "true" : "false" }
        if let i = v.intValue { return String(i) }
        if let d = v.doubleValue { return String(d) }
        return JobFormat.prettyJSON(["v": v]) ?? ""
    }
}

@Observable @MainActor
final class JobRunDetailModel {
    var run: JobRun?
    var jobName: String?
    var error: Error?
    var actionError: Error?
    var busy = false

    func load(_ runId: String, jobId: String, api: APIClient) async {
        do {
            run = try await api.getJobRun(runId)
            error = nil
            if jobName == nil { jobName = try? await api.getJob(jobId).name }
        } catch {
            if run == nil { self.error = error }
        }
    }

    func retry(_ runId: String, api: APIClient) async {
        busy = true; defer { busy = false }
        do { run = try await api.retryJobRun(runId) } catch { actionError = error }
    }

    func cancel(_ runId: String, api: APIClient) async {
        busy = true; defer { busy = false }
        do { run = try await api.cancelJobRun(runId) } catch { actionError = error }
    }
}
