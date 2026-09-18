import SwiftUI

@Observable
@MainActor
final class ClusterModel {
    enum Tab: String, CaseIterable { case pods, repoPods, events, health, services }

    var overview: ClusterOverview?
    var repoPods: [RepoPodRecord] = []
    var healthEvents: [PodHealthEvent] = []
    var version: ClusterVersion?
    var forbidden = false
    var error: Error?
    var loading = true
    var tab: Tab = .pods

    func load(api: APIClient) async {
        async let v = api.clusterVersion()
        do {
            overview = try await api.clusterOverview()
            forbidden = false
            error = nil
        } catch let e as APIError where e.status == 403 {
            forbidden = true
        } catch {
            self.error = error
        }
        if !forbidden {
            async let pods = api.clusterPods()
            async let events = api.healthEvents(limit: 50)
            if let p = try? await pods { repoPods = p }
            if let e = try? await events { healthEvents = e }
        }
        version = try? await v
        loading = false
    }
}

/// Mirrors `apps/web/src/app/cluster/page.tsx` (admin only; polls every 8s).
struct ClusterView: View {
    @Environment(APIClient.self) private var api
    @State private var model = ClusterModel()

    var body: some View {
        Group {
            if model.forbidden {
                VStack(spacing: 12) {
                    AdminOnlyState(what: "The cluster view")
                    versionRow
                }
            } else if model.loading, model.overview == nil {
                if let error = model.error {
                    List { ErrorRow(error: error, what: "the cluster") { Task { await model.load(api: api) } } }.listStyle(.plain)
                } else {
                    List { SkeletonStrip(labels: ["Nodes", "Pods", "Agents", "Infra"]).listRowSeparator(.hidden).listRowBackground(Color.clear); SkeletonRows() }.listStyle(.plain)
                }
            } else if let ov = model.overview {
                content(ov)
            } else if let error = model.error {
                List { ErrorRow(error: error, what: "the cluster") { Task { await model.load(api: api) } } }.listStyle(.plain)
            }
        }
        .task {
            while !Task.isCancelled {
                await model.load(api: api)
                try? await Task.sleep(for: .seconds(8))
            }
        }
        .navigationDestination(for: RepoPodRecord.self) { PodDetailView(podId: $0.id) }
    }

    private func content(_ ov: ClusterOverview) -> some View {
        List {
            Section {
                StatStrip(items: [
                    StatItem("Nodes", text: "\(ov.summary.readyNodes)/\(ov.summary.totalNodes)", tone: ov.summary.readyNodes < ov.summary.totalNodes ? .danger : nil),
                    StatItem("Pods", text: "\(ov.summary.runningPods)/\(ov.summary.totalPods)"),
                    StatItem("Agents", ov.summary.agentPods),
                    StatItem("Infra", ov.summary.infraPods),
                ])
                .listRowInsets(EdgeInsets(top: Spacing.xs, leading: Spacing.l, bottom: Spacing.xs, trailing: Spacing.l))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                versionRow.listRowSeparator(.hidden)
            }

            if !ov.nodes.isEmpty {
                Section {
                    ForEach(ov.nodes) { node in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                if !node.isReady { StateDot(tone: .danger) }
                                Text(node.name).font(.monoSubheadline)
                                Spacer()
                                Text(node.kubeletVersion ?? "").font(.caption).foregroundStyle(.tertiary)
                            }
                            Text.meta([
                                "\(Self.num(node.cpu)) cores",
                                node.memoryUsedGi?.value.map { String(format: "%.1f / %.1f Gi", $0, node.memoryTotalGi?.value ?? 0) } ?? InsightsFormat.k8sResource(node.memory),
                                node.containerRuntime,
                            ])?
                            .font(.footnote).foregroundStyle(.secondary)
                            if ov.metricsAvailable == true, let cpu = node.cpuPercent?.value {
                                RateBar(label: "CPU", valueText: "\(Int(cpu))%", fraction: cpu / 100)
                            }
                            if ov.metricsAvailable == true, let mem = node.memoryPercent {
                                RateBar(label: "Memory", valueText: "\(mem)%", fraction: Double(mem) / 100)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    if ov.metricsAvailable == false {
                        Text("metrics-server not detected — CPU and memory usage unavailable.")
                            .font(.footnote).foregroundStyle(.tertiary)
                    }
                } header: {
                    SectionHeader(title: "Nodes").textCase(nil)
                }
            }

            Section {
                Picker("Show", selection: $model.tab) {
                    Text("Pods").tag(ClusterModel.Tab.pods)
                    Text("Repo pods").tag(ClusterModel.Tab.repoPods)
                    Text("Events").tag(ClusterModel.Tab.events)
                    Text("Health").tag(ClusterModel.Tab.health)
                    Text("Services").tag(ClusterModel.Tab.services)
                }
                .pickerStyle(.segmented)
                .listRowInsets(EdgeInsets(top: Spacing.xs, leading: Spacing.l, bottom: Spacing.xs, trailing: Spacing.l))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)

                switch model.tab {
                case .pods: podsTab(ov)
                case .repoPods: repoPodsTab
                case .events: eventsTab(ov)
                case .health: healthTab
                case .services: servicesTab(ov)
                }
            }
        }
        .listStyle(.plain)
        .animation(.snappy, value: model.tab)
        .refreshable { await model.load(api: api) }
    }

    // MARK: Version

    @ViewBuilder
    private var versionRow: some View {
        if let v = model.version {
            HStack(spacing: 6) {
                Text("Optio \(v.current ?? "unknown")").font(.footnote).foregroundStyle(.secondary)
                if v.updateAvailable == true, let latest = v.latest {
                    Text("· \(latest) available").font(.footnote).foregroundStyle(AppTheme.accent)
                } else if let latest = v.latest {
                    Text("· latest \(latest)").font(.footnote).foregroundStyle(.tertiary)
                }
            }
        }
    }

    // MARK: Tabs

    @ViewBuilder
    private func podsTab(_ ov: ClusterOverview) -> some View {
        if ov.pods.isEmpty {
            Text("No pods in the optio namespace").font(.caption).foregroundStyle(.secondary)
        }
        ForEach(ov.pods) { pod in
            let repoPod = ov.repoPods.first { $0.podName == pod.name }
            let tone = Self.statusTone(pod.status)
            let row = OptioRow(
                title: pod.name,
                tone: tone == .success ? nil : tone,
                meta: Text.meta([
                    Text(pod.status ?? "Unknown"),
                    pod.isOptioManaged == true ? Text("workspace") : nil,
                    pod.isInfra == true ? Text("infra") : nil,
                    pod.cpuMillicores.map { Text("\($0)m CPU") },
                    pod.memoryMi.map { Text("\($0) Mi") },
                    (pod.restarts ?? 0) > 0 ? Text("\(pod.restarts!) restarts") : nil,
                ]),
                trailing: tone == .danger ? (pod.status ?? "Failed") : pod.startedAt?.relativeDescription,
                trailingTone: tone == .danger ? .danger : nil,
                footer: pod.shortImage.map { Text($0).font(.monoFootnote) },
                titleLineLimit: 1
            )
            if let repoPod {
                NavigationLink(value: repoPod) { row }
            } else {
                row
            }
        }
    }

    @ViewBuilder
    private var repoPodsTab: some View {
        if model.repoPods.isEmpty {
            Text("No repo pods").font(.caption).foregroundStyle(.secondary)
        }
        ForEach(model.repoPods) { rp in
            NavigationLink(value: rp) {
                OptioRow(
                    title: "\(InsightsFormat.repoShortName(rp.repoUrl ?? "")) #\(rp.instanceIndex ?? 0)",
                    tone: Tone.forState(rp.state),
                    meta: Text.meta([
                        Text((rp.state ?? "unknown").replacingOccurrences(of: "_", with: " ")),
                        Text("\(rp.activeTaskCount ?? 0) active"),
                        (rp.queuedTaskCount ?? 0) > 0 ? Text("\(rp.queuedTaskCount!) queued") : nil,
                        rp.podName.map { Text.mono($0) },
                    ]),
                    trailing: rp.lastTaskAt.map { "last \($0.relativeDescription)" },
                    titleLineLimit: 1
                )
            }
        }
    }

    @ViewBuilder
    private func eventsTab(_ ov: ClusterOverview) -> some View {
        if ov.events.isEmpty {
            Text("No recent events").font(.caption).foregroundStyle(.secondary)
        }
        ForEach(Array(ov.events.enumerated()), id: \.offset) { _, e in
            OptioRow(
                title: e.reason ?? "Event",
                tone: e.type == "Warning" ? .danger : nil,
                meta: Text.meta([e.involvedObject.map { Text.mono($0) }, (e.count ?? 0) > 1 ? Text("×\(e.count!)") : nil]),
                trailing: e.lastTimestamp?.relativeDescription,
                footer: e.message.map { Text($0) },
                titleLineLimit: 1
            )
        }
    }

    @ViewBuilder
    private var healthTab: some View {
        if model.healthEvents.isEmpty {
            Text("No pod health events").font(.caption).foregroundStyle(.secondary)
        }
        ForEach(model.healthEvents) { HealthEventRow(event: $0) }
    }

    @ViewBuilder
    private func servicesTab(_ ov: ClusterOverview) -> some View {
        ForEach(ov.services) { svc in
            OptioRow(
                title: svc.name ?? "",
                meta: Text.meta([svc.type.map { Text($0) }, svc.clusterIP.map { Text.mono($0) }] + (svc.ports ?? []).map { p in Text.mono("\(p.port ?? 0)→\(Int(p.targetPort?.value ?? 0))/\(p.proto ?? "")") }),
                titleLineLimit: 1
            )
        }
    }

    // MARK: Helpers

    static func statusTone(_ status: String?) -> Tone {
        switch status ?? "" {
        case "Running", "Ready", "ready", "Succeeded": return .success
        case "Pending", "provisioning", "ContainerCreating": return .working
        case "ImagePullBackOff", "ErrImagePull", "CrashLoopBackOff", "Error", "error", "Failed", "failed", "NotReady", "OOMKilled": return .danger
        default: return .idle
        }
    }

    private static func num(_ v: LooseDouble?) -> String {
        guard let d = v?.value else { return "?" }
        return d == d.rounded() ? String(Int(d)) : String(format: "%.1f", d)
    }
}

struct HealthEventRow: View {
    let event: PodHealthEvent

    private var tone: Tone? {
        switch event.eventType ?? "" {
        case "healthy", "orphan_cleaned": return nil
        case "restarted": return .working
        default: return .danger
        }
    }

    var body: some View {
        OptioRow(
            title: (event.eventType ?? "event").replacingOccurrences(of: "_", with: " ").capitalized,
            tone: tone,
            meta: event.podName.map { Text.mono($0) },
            trailing: event.createdAt?.relativeDescription,
            footer: event.message.map { Text($0) },
            titleLineLimit: 1
        )
    }
}
