import SwiftUI

/// Mirrors `apps/web/src/app/cluster/[id]/page.tsx`: repo pod record, its tasks,
/// pod-scoped health events, and a confirmed restart.
struct PodDetailView: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    let podId: String

    @State private var pod: RepoPodDetail?
    @State private var events: [PodHealthEvent] = []
    @State private var error: Error?
    @State private var confirmRestart = false
    @State private var restarting = false
    @State private var actionError: Error?

    var body: some View {
        Group {
            if let pod {
                content(pod)
            } else if let error {
                if error.isForbidden { AdminOnlyState(what: "Pod detail") } else {
                    ErrorRow(error: error) { Task { await load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(pod?.podName ?? "Pod")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(role: .destructive) { confirmRestart = true } label: {
                    Label("Restart", systemImage: "arrow.counterclockwise")
                }
                .disabled(restarting || pod == nil)
            }
        }
        .confirmationDialog("Restart this pod? Active tasks will be failed.", isPresented: $confirmRestart, titleVisibility: .visible) {
            Button("Restart pod", role: .destructive) { Task { await restart() } }
            Button("Cancel", role: .cancel) {}
        }
        .errorToast($actionError)
        .task { await load() }
    }

    private func content(_ pod: RepoPodDetail) -> some View {
        let runtimeState = pod.k8sPod?.status?.lowercased() ?? pod.state ?? "unknown"
        return List {
            Section {
                LabeledContent("State") { StatusBadge(text: runtimeState, tone: ClusterView.statusTone(pod.k8sPod?.status) == .idle ? Tone.forState(pod.state ?? "") : ClusterView.statusTone(pod.k8sPod?.status)) }
                LabeledContent("Repo", value: InsightsFormat.repoShortName(pod.repoUrl ?? ""))
                if let b = pod.repoBranch { LabeledContent("Branch", value: b) }
                LabeledContent("Active tasks", value: "\(pod.activeTaskCount ?? 0)")
                if let c = pod.createdAt { LabeledContent("Created", value: c.relativeDescription) }
                if let s = pod.k8sPod?.startedAt { LabeledContent("Started", value: s.relativeDescription) }
                if let l = pod.lastTaskAt { LabeledContent("Last task", value: l.relativeDescription) }
                if let m = pod.managedBy { LabeledContent("Managed by", value: m) }
                if let pvc = pod.cachePvcName { LabeledContent("Cache PVC", value: "\(pvc) (\(pod.cachePvcState ?? "?"))") }
            }
            if let k = pod.k8sPod {
                Section("Kubernetes") {
                    if let p = k.phase { LabeledContent("Phase", value: p) }
                    if let n = k.nodeName { LabeledContent("Node", value: n) }
                    if let ip = k.ip { LabeledContent("IP", value: ip) }
                    if let r = k.restarts { LabeledContent("Restarts", value: "\(r)") }
                    if let img = k.image { LabeledContent("Image") { Text(img).font(.caption.monospaced()).lineLimit(2).multilineTextAlignment(.trailing) } }
                }
            }
            if let err = pod.errorMessage, !err.isEmpty {
                Section("Error") { Text(err).font(.caption).foregroundStyle(.red) }
            }
            Section("Tasks (\(pod.tasks?.count ?? 0))") {
                if let tasks = pod.tasks, !tasks.isEmpty {
                    ForEach(tasks) { t in
                        HStack(spacing: 8) {
                            StatusBadge(text: t.state ?? "unknown", tone: Tone.forState(t.state ?? ""))
                            Text(t.title ?? t.id).font(.subheadline).lineLimit(1)
                            Spacer()
                            VStack(alignment: .trailing) {
                                if let a = t.agentType { Text(a.replacingOccurrences(of: "-", with: " ")) }
                                if let c = t.createdAt { Text(c.relativeDescription) }
                            }
                            .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Text("No tasks have run on this pod yet.").font(.caption).foregroundStyle(.secondary)
                }
            }
            if !events.isEmpty {
                Section("Health events") {
                    ForEach(events) { HealthEventRow(event: $0) }
                }
            }
        }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            pod = try await api.clusterPod(id: podId)
            error = nil
            if let all = try? await api.healthEvents(limit: 50) {
                events = all.filter { $0.repoPodId == podId }
            }
        } catch {
            self.error = error
        }
    }

    private func restart() async {
        restarting = true
        defer { restarting = false }
        do {
            try await api.restartClusterPod(id: podId)
            dismiss()
        } catch {
            actionError = error
        }
    }
}
