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
                ChipPicker(options: [(Section.logs, "Logs"), (Section.details, "Details")], selection: $section)
                Divider()
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
                ErrorBanner(error: error) { Task { await model.load(runId, jobId: jobId, api: api) } }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle("Run \(runId.prefix(8))")
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
        .alert("Error", isPresented: Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.actionError?.localizedDescription ?? "")
        }
    }

    private func header(_ run: JobRun) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                StatusBadge(text: run.state, color: StateColor.color(for: run.state))
                if let name = model.jobName { Text(name).font(.subheadline.weight(.medium)).lineLimit(1) }
                Spacer()
                if logs.connected { Image(systemName: "dot.radiowaves.left.and.right").foregroundStyle(.green).font(.caption) }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    if let m = run.modelUsed { Label(m, systemImage: "cpu") }
                    if let d = run.durationText { Label(d, systemImage: "clock") } else if let c = run.createdAt { Label(c.relativeDescription, systemImage: "clock") }
                    if let c = JobFormat.cost(run.costUsd, digits: 4) { Label(c, systemImage: "dollarsign.circle") }
                    if let t = run.tokensText { Label(t, systemImage: "text.word.spacing") }
                    if let r = run.retryCount, r > 0 { Label("retry \(r)", systemImage: "arrow.counterclockwise") }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            if let err = run.errorMessage, !err.isEmpty {
                Label(err, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(section == .details ? nil : 3)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
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
