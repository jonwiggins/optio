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
                    ErrorBanner(error: error) { Task { await model.load(api: api) } }
                } else {
                    ProgressView()
                }
            } else if let ov = model.overview {
                content(ov)
            } else if let error = model.error {
                ErrorBanner(error: error) { Task { await model.load(api: api) } }
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
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    StatTile(title: "Nodes ready", value: "\(ov.summary.readyNodes)/\(ov.summary.totalNodes)", color: .green, systemImage: "server.rack")
                    StatTile(title: "Pods running", value: "\(ov.summary.runningPods)/\(ov.summary.totalPods)", color: AppTheme.accent, systemImage: "shippingbox")
                    StatTile(title: "Agent pods", value: "\(ov.summary.agentPods)", color: .yellow, systemImage: "waveform.path.ecg")
                    StatTile(title: "Infrastructure", value: "\(ov.summary.infraPods)", color: .blue, systemImage: "cylinder")
                }
                .listRowSeparator(.hidden)
                versionRow.listRowSeparator(.hidden)
            }

            if !ov.nodes.isEmpty {
                Section("Nodes") {
                    ForEach(ov.nodes) { node in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                Circle().fill(node.isReady ? Color.green : Color.red).frame(width: 8, height: 8)
                                Text(node.name).font(.caption.monospaced().weight(.medium))
                                Spacer()
                                Text(node.kubeletVersion ?? "").font(.caption2).foregroundStyle(.secondary)
                            }
                            HStack(spacing: 12) {
                                if let cpu = node.cpuPercent?.value {
                                    Label("\(Int(cpu))% of \(Self.num(node.cpu)) cores", systemImage: "cpu")
                                } else {
                                    Label("\(Self.num(node.cpu)) cores", systemImage: "cpu")
                                }
                                if let used = node.memoryUsedGi?.value {
                                    Label(String(format: "%.1f / %.1f Gi", used, node.memoryTotalGi?.value ?? 0), systemImage: "memorychip")
                                } else {
                                    Label(InsightsFormat.k8sResource(node.memory), systemImage: "memorychip")
                                }
                            }
                            .font(.caption2).foregroundStyle(.secondary)
                            if ov.metricsAvailable == true, let cpu = node.cpuPercent?.value {
                                RateBar(label: "CPU", valueText: "\(Int(cpu))%", fraction: cpu / 100)
                            }
                            if ov.metricsAvailable == true, let mem = node.memoryPercent {
                                RateBar(label: "Memory", valueText: "\(mem)%", fraction: Double(mem) / 100, color: .blue)
                            }
                            if let rt = node.containerRuntime { Text(rt).font(.caption2).foregroundStyle(.tertiary) }
                        }
                        .padding(.vertical, 2)
                    }
                    if ov.metricsAvailable == false {
                        Text("metrics-server not detected — CPU and memory usage unavailable.")
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            }

            Section {
                ChipPicker(options: [
                    (ClusterModel.Tab.pods, "Pods (\(ov.pods.count))"),
                    (.repoPods, "Repo pods (\(model.repoPods.count))"),
                    (.events, "Events (\(ov.events.count))"),
                    (.health, "Health (\(model.healthEvents.count))"),
                    (.services, "Services (\(ov.services.count))"),
                ], selection: $model.tab)
                .listRowInsets(EdgeInsets())
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
        .refreshable { await model.load(api: api) }
    }

    // MARK: Version

    @ViewBuilder
    private var versionRow: some View {
        if let v = model.version {
            HStack(spacing: 6) {
                Image(systemName: "tag").foregroundStyle(.secondary)
                Text("Optio \(v.current ?? "unknown")").font(.caption.weight(.medium))
                if v.updateAvailable == true, let latest = v.latest {
                    StatusBadge(text: "v\(latest) available", color: AppTheme.accent)
                } else if let latest = v.latest {
                    Text("latest \(latest)").font(.caption2).foregroundStyle(.tertiary)
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
            let row = VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Circle().fill(Self.statusColor(pod.status)).frame(width: 8, height: 8)
                    Text(pod.name).font(.caption.monospaced().weight(.medium)).lineLimit(1)
                    if pod.isOptioManaged == true { StatusBadge(text: "workspace", color: AppTheme.accent) }
                    if pod.isInfra == true { StatusBadge(text: "infra", color: .blue) }
                }
                HStack(spacing: 8) {
                    Text(pod.status ?? "Unknown").foregroundStyle(Self.statusColor(pod.status))
                    if let c = pod.cpuMillicores { Text("\(c)m CPU") }
                    if let m = pod.memoryMi { Text("\(m) Mi") }
                    if let r = pod.restarts, r > 0 { Text("\(r) restarts").foregroundStyle(.yellow) }
                    if let s = pod.startedAt { Text(s.relativeDescription) }
                }
                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                if let img = pod.shortImage { Text(img).font(.caption2.monospaced()).foregroundStyle(.tertiary).lineLimit(1) }
            }
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
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        StatusBadge(text: rp.state ?? "unknown", color: StateColor.color(for: rp.state ?? ""))
                        Text(InsightsFormat.repoShortName(rp.repoUrl ?? "")).font(.subheadline.weight(.medium)).lineLimit(1)
                        Spacer()
                        Text("#\(rp.instanceIndex ?? 0)").font(.caption2.monospaced()).foregroundStyle(.tertiary)
                    }
                    HStack(spacing: 8) {
                        if let n = rp.podName { Text(n).font(.caption2.monospaced()) }
                        Text("\(rp.activeTaskCount ?? 0) active")
                        if let q = rp.queuedTaskCount, q > 0 { Text("\(q) queued") }
                        if let l = rp.lastTaskAt { Text("last \(l.relativeDescription)") }
                    }
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
    }

    @ViewBuilder
    private func eventsTab(_ ov: ClusterOverview) -> some View {
        if ov.events.isEmpty {
            Text("No recent events").font(.caption).foregroundStyle(.secondary)
        }
        ForEach(Array(ov.events.enumerated()), id: \.offset) { _, e in
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(e.type == "Warning" ? Color.yellow : Color.blue)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(e.reason ?? "").font(.caption.weight(.medium))
                        Text(e.involvedObject ?? "").font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                        if let c = e.count, c > 1 { Text("x\(c)").font(.caption2).foregroundStyle(.secondary) }
                    }
                    if let m = e.message { Text(m).font(.caption2).foregroundStyle(.secondary) }
                    if let t = e.lastTimestamp { Text(t.relativeDescription).font(.caption2).foregroundStyle(.tertiary) }
                }
            }
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
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Image(systemName: "network").font(.caption).foregroundStyle(.secondary)
                    Text(svc.name ?? "").font(.caption.monospaced().weight(.medium))
                    Text(svc.type ?? "").font(.caption2).foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    if let ip = svc.clusterIP { Text(ip) }
                    ForEach(Array((svc.ports ?? []).enumerated()), id: \.offset) { _, p in
                        Text("\(p.port ?? 0)→\(Int(p.targetPort?.value ?? 0))/\(p.proto ?? "")")
                    }
                }
                .font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Helpers

    static func statusColor(_ status: String?) -> Color {
        switch status ?? "" {
        case "Running", "Ready", "ready": return .green
        case "Pending", "provisioning": return .yellow
        case "ImagePullBackOff", "ErrImagePull", "CrashLoopBackOff", "Error", "error", "Failed", "failed", "NotReady": return .red
        default: return .secondary
        }
    }

    private static func num(_ v: LooseDouble?) -> String {
        guard let d = v?.value else { return "?" }
        return d == d.rounded() ? String(Int(d)) : String(format: "%.1f", d)
    }
}

struct HealthEventRow: View {
    let event: PodHealthEvent

    private var color: Color {
        switch event.eventType ?? "" {
        case "healthy", "orphan_cleaned": return .green
        case "restarted": return .yellow
        default: return .red
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Circle().fill(color).frame(width: 8, height: 8)
                Text((event.eventType ?? "event").replacingOccurrences(of: "_", with: " ").capitalized).font(.caption.weight(.medium))
                if let n = event.podName { Text(n).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1) }
                Spacer()
                if let c = event.createdAt { Text(c.relativeDescription).font(.caption2).foregroundStyle(.secondary) }
            }
            if let m = event.message { Text(m).font(.caption2).foregroundStyle(.secondary).padding(.leading, 14) }
        }
    }
}
