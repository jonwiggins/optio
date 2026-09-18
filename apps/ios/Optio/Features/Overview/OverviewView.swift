import Charts
import SwiftUI

/// The Overview tab. Mirrors `apps/web/src/app/page.tsx`: pipeline stat strips for
/// Tasks / Jobs / Agents / Sessions, Claude usage, cluster summary, active sessions,
/// and recent tasks. Polls every 10 seconds while visible.
struct OverviewView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppRouter.self) private var router
    @State private var model = OverviewModel()

    var body: some View {
        NavigationStack {
            Group {
                if model.loading, model.taskStats == nil {
                    if let error = model.error {
                        List { ErrorRow(error: error, what: "the overview") { Task { await model.refresh(api: api) } } }.listStyle(.plain)
                    } else {
                        List {
                            Section { SkeletonStrip(labels: ["Queue", "Running", "In review", "Needs you", "Failed"]) }
                                .listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
                            Section { SkeletonRows() }
                        }
                        .listStyle(.insetGrouped)
                    }
                } else if model.isFirstRun {
                    welcome
                } else {
                    content
                }
            }
            .navigationTitle("Overview")
            .navigationSubtitleIfAvailable(subtitleText)
            .hubChrome()
            .navigationDestination(for: DashRecentTask.self) { TaskDetailView(taskId: $0.id) }
            .navigationDestination(for: DashSessionRow.self) { SessionDetailView(sessionId: $0.id) }
            .task {
                while !Task.isCancelled {
                    await model.refresh(api: api)
                    try? await Task.sleep(for: .seconds(10))
                }
            }
        }
    }

    // MARK: Sections

    private var content: some View {
        List {
            Section {
                if #unavailable(iOS 26) {
                    subtitle
                        .listRowInsets(EdgeInsets(top: 0, leading: Spacing.l, bottom: Spacing.s, trailing: Spacing.l))
                        .listRowBackground(Color.clear)
                }
                if let error = model.error {
                    ErrorRow(error: error, what: "the overview") { Task { await model.refresh(api: api) } }
                        .listRowBackground(Color.clear)
                }
            }

            stripSection("Tasks", destination: .tasks, items: taskItems(model.taskStats))

            if let s = model.standaloneStats, s.total > 0 {
                stripSection("Jobs", destination: .jobs, items: [
                    StatItem("Queue", s.queued), StatItem("Running", s.running),
                    StatItem("Failed", s.failed, tone: .danger), StatItem("Done", s.completed),
                ])
            }

            if let s = model.agentStats, s.total > 0 {
                stripSection("Agents", destination: .agents, items: [
                    StatItem("Idle", s.idle), StatItem("Running", s.running + s.queued),
                    StatItem("Needs you", s.paused, tone: .accent), StatItem("Failed", s.failed, tone: .danger),
                ])
            }

            if let s = model.sessionStats, s.total > 0 {
                stripSection("Sessions", destination: .sessions, items: [
                    StatItem("Active", s.active), StatItem("Ended today", s.ended),
                ])
            }

            if let usage = model.usage, usage.claudeAuthFailed || usage.githubAuthFailed || usage.available {
                Section {
                    UsagePanelView(usage: usage) { await model.refreshUsage(api: api) }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                } header: {
                    if usage.available, !usage.claudeAuthFailed { SectionHeader(title: "Claude usage").textCase(nil) }
                }
            }

            Section {
                ClusterSummaryCard(
                    cluster: model.cluster,
                    forbidden: model.clusterForbidden,
                    totalCost: model.totalRecentCost,
                    history: model.metricsHistory
                )
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            } header: {
                SectionHeader(title: "Cluster", action: model.clusterForbidden ? nil : { router.open(.cluster) }).textCase(nil)
            }

            if !model.activeSessions.isEmpty {
                Section {
                    ForEach(model.activeSessions) { s in
                        NavigationLink(value: s) {
                            OptioRow(
                                title: s.branch ?? "Session \(s.id.prefix(8))",
                                tone: .working,
                                meta: Text.meta([InsightsFormat.repoShortName(s.repoUrl ?? ""), s.createdAt.map { "started \($0.relativeDescription)" }]),
                                titleLineLimit: 1
                            )
                        }
                    }
                } header: {
                    SectionHeader(title: "Active sessions", detail: "\(model.activeSessionCount)") { router.open(.sessions) }.textCase(nil)
                }
            }

            Section {
                if model.recentTasks.isEmpty {
                    EmptyState(title: "No tasks yet", systemImage: "checklist", message: "Put an agent to work in a repo from the Run tab.", actionTitle: "Go to Tasks") { router.open(.tasks) }
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(model.recentTasks) { task in
                        NavigationLink(value: task) { RecentTaskRow(task: task) }
                    }
                }
            } header: {
                SectionHeader(title: "Recent tasks") { router.open(.tasks) }.textCase(nil)
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await model.refresh(api: api) }
    }

    private func stripSection(_ title: String, destination: AppRouter.Section, items: [StatItem]) -> some View {
        Section {
            StatStrip(items: items)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
        } header: {
            SectionHeader(title: title) { router.open(destination) }.textCase(nil)
        }
    }

    private var subtitleText: String {
        let running = model.taskStats?.running ?? 0
        let attention = model.taskStats?.needsAttention ?? 0
        var s = "\(running) active"
        if attention > 0 { s += " · \(attention) need\(attention == 1 ? "s" : "") you" }
        return s
    }

    /// "0 active · 2 need you" — only the second half in accent.
    private var subtitle: some View {
        let running = model.taskStats?.running ?? 0
        let attention = model.taskStats?.needsAttention ?? 0
        return HStack(spacing: 6) {
            Text("\(running) active").contentTransition(.numericText())
            if model.activeSessionCount > 0 {
                Text("·").foregroundStyle(.tertiary)
                Text("\(model.activeSessionCount) \(model.activeSessionCount == 1 ? "session" : "sessions")")
            }
            if attention > 0 {
                Text("·").foregroundStyle(.tertiary)
                Text("\(attention) need\(attention == 1 ? "s" : "") you")
                    .foregroundStyle(AppTheme.accent)
                    .contentTransition(.numericText())
            }
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }

    private var welcome: some View {
        ScrollView {
            VStack(spacing: Spacing.l) {
                Image(systemName: "sparkles")
                    .font(.largeTitle.weight(.thin))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.secondary)
                Text("Welcome to Optio").font(.title2.weight(.semibold))
                Text(model.repoCount == 0
                     ? "Add a repository from the web UI, then create your first task to get an AI agent working on your code."
                     : "\(model.repoCount ?? 0) \(model.repoCount == 1 ? "repo" : "repos") connected. Create your first task from the Run tab.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                if model.repoCount != 0 {
                    Button("Go to Tasks") { router.open(.tasks) }.buttonStyle(.borderedProminent).tint(.primary)
                }
                UsagePanelView(usage: model.usage) { await model.refreshUsage(api: api) }
            }
            .padding()
            .frame(maxWidth: .infinity)
        }
        .refreshable { await model.refresh(api: api) }
    }

    // MARK: Stages (pipeline-stats-bar.tsx)

    private func taskItems(_ s: DashTaskStats?) -> [StatItem] {
        [
            StatItem("Queue", s?.queued ?? 0),
            StatItem("Running", s?.running ?? 0),
            StatItem("In review", (s?.ci ?? 0) + (s?.review ?? 0)),
            StatItem("Needs you", s?.needsAttention ?? 0, tone: .accent),
            StatItem("Failed", s?.failed ?? 0, tone: .danger),
        ]
    }
}

private extension View {
    @ViewBuilder
    func navigationSubtitleIfAvailable(_ text: String) -> some View {
        if #available(iOS 26, *) {
            self.navigationSubtitle(text)
        } else {
            self
        }
    }
}

// MARK: - Usage panel (usage-panel.tsx)

struct UsagePanelView: View {
    let usage: ClaudeUsageData?
    let onRefresh: () async -> Void

    var body: some View {
        if let usage {
            if usage.claudeAuthFailed || usage.githubAuthFailed {
                VStack(spacing: Spacing.s) {
                    if usage.claudeAuthFailed {
                        tokenBanner(
                            title: "Claude token expired",
                            message: "Agents are failing to authenticate. Renew the Claude OAuth token from the web UI (Settings → Secrets), or run scripts/update-claude-auth.sh on the host."
                        )
                    }
                    if usage.githubAuthFailed {
                        tokenBanner(
                            title: "GitHub token failing",
                            message: "Recent tasks hit GitHub auth errors. Rotate GITHUB_TOKEN in Settings → Secrets."
                        )
                    }
                }
            } else if usage.available {
                let meters = self.meters(usage)
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
                    ForEach(meters, id: \.label) { m in
                        ClaudeUsageMeter(label: m.label, utilization: m.utilization, resetsAt: m.resetsAt, sublabel: m.sublabel)
                    }
                }
                .cardSurface()
            }
        }
    }

    private struct Meter { let label: String; let utilization: Double; let resetsAt: String?; let sublabel: String? }

    private func meters(_ u: ClaudeUsageData) -> [Meter] {
        var out: [Meter] = []
        if let w = u.fiveHour, let v = w.utilization { out.append(Meter(label: "5-hour", utilization: v, resetsAt: w.resetsAt, sublabel: nil)) }
        if let w = u.sevenDay, let v = w.utilization { out.append(Meter(label: "7-day", utilization: v, resetsAt: w.resetsAt, sublabel: nil)) }
        if let w = u.sevenDaySonnet, let v = w.utilization { out.append(Meter(label: "7d Sonnet", utilization: v, resetsAt: w.resetsAt, sublabel: nil)) }
        if let w = u.sevenDayOpus, let v = w.utilization { out.append(Meter(label: "7d Opus", utilization: v, resetsAt: w.resetsAt, sublabel: nil)) }
        if let x = u.extraUsage, x.isEnabled == true, let used = x.usedCredits {
            let spent = Cost.format(used / 100)
            let sub = x.monthlyLimit.map { "\(spent) / \(Cost.format($0 / 100)) spent" } ?? "\(spent) spent"
            out.append(Meter(label: "Extra credits", utilization: x.utilization ?? 0, resetsAt: nil, sublabel: sub))
        }
        return out
    }

    private func tokenBanner(title: String, message: String) -> some View {
        NoticeBanner(tone: .danger, systemImage: "key.slash", title: title) {
            Text(message)
            Button("Re-check") { Task { await onRefresh() } }
                .font(.footnote.weight(.semibold))
                .buttonStyle(.plain)
                .foregroundStyle(AppTheme.accent)
        }
    }
}

struct ClaudeUsageMeter: View {
    let label: String
    let utilization: Double
    let resetsAt: String?
    var sublabel: String? = nil

    private var pct: Double { min(max(utilization, 0), 100) }
    private var tone: Tone { pct >= 90 ? .danger : .working }

    private var resetLabel: String? {
        guard let resetsAt, let date = resetsAt.isoDate else { return nil }
        let diff = date.timeIntervalSinceNow
        guard diff > 0 else { return nil }
        let h = Int(diff / 3600)
        let m = Int(diff.truncatingRemainder(dividingBy: 3600) / 60)
        return h > 0 ? "\(h)h \(m)m" : "\(m)m"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack {
                Text(label).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text("\(Int(pct.rounded()))%")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(tone == .danger ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
                    .contentTransition(.numericText())
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.fill.secondary)
                    Capsule().fill(tone == .danger ? AnyShapeStyle(.red) : AnyShapeStyle(.primary)).frame(width: geo.size.width * pct / 100)
                }
            }
            .frame(height: 5)
            if let sublabel {
                Text(sublabel).font(.caption2).foregroundStyle(.tertiary)
            }
            if let resetLabel {
                Text("resets in \(resetLabel)").font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }
}

// MARK: - Cluster summary (cluster-summary.tsx)

struct ClusterSummaryCard: View {
    let cluster: ClusterOverview?
    let forbidden: Bool
    let totalCost: Double
    let history: [MetricsSample]
    @State private var showMetrics = false

    var body: some View {
        if forbidden {
            HStack(spacing: Spacing.s) {
                Image(systemName: "lock").foregroundStyle(.secondary)
                Text("Cluster summary is available to workspace admins.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardSurface()
        } else if let cluster {
            let s = cluster.summary
            let node = cluster.nodes.first
            VStack(alignment: .leading, spacing: Spacing.m) {
                HStack(alignment: .firstTextBaseline) {
                    if let node {
                        Text(node.name).font(.monoFootnote).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                    Spacer()
                    if totalCost > 0 {
                        Text(Cost.format(totalCost)).font(.statValue).contentTransition(.numericText())
                        Text("recent").font(.caption).foregroundStyle(.secondary)
                    }
                }
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: Spacing.s) {
                    metric("Nodes", "\(s.readyNodes)/\(s.totalNodes)", tone: s.readyNodes < s.totalNodes ? .danger : nil)
                    metric("Pods", "\(s.runningPods)/\(s.totalPods)")
                    metric("Agents", "\(s.agentPods)")
                    if let node {
                        if let cpu = node.cpuPercent?.value {
                            metric("CPU", "\(Int(cpu))% · \(formatLoose(node.cpu)) cores")
                        } else {
                            metric("CPU", "\(formatLoose(node.cpu)) cores")
                        }
                        if let used = node.memoryUsedGi?.value {
                            metric("Memory", "\(fmt1(used)) / \(fmt1(node.memoryTotalGi?.value ?? 0)) Gi")
                        } else {
                            metric("Memory", InsightsFormat.k8sResource(node.memory))
                        }
                    }
                    metric("Infra", "\(s.infraPods)")
                }
                if node != nil {
                    Button {
                        withAnimation(.snappy) { showMetrics.toggle() }
                    } label: {
                        Label(showMetrics ? "Hide metrics" : "Show metrics", systemImage: showMetrics ? "chevron.up" : "chart.xyaxis.line")
                            .font(.footnote)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                }
                if showMetrics {
                    Divider()
                    if cluster.metricsAvailable == false {
                        Text("metrics-server not detected — CPU and memory charts unavailable.")
                            .font(.footnote).foregroundStyle(.tertiary)
                    } else if history.count > 1 {
                        MiniLine(label: "CPU", values: history.map { ($0.time, $0.cpuPercent ?? 0) }, suffix: "%", max: 100, color: ChartPalette.color(0))
                        MiniLine(label: "Memory", values: history.map { ($0.time, $0.memoryPercent ?? 0) }, suffix: "%", max: 100, color: ChartPalette.color(1))
                        MiniLine(label: "Pods", values: history.map { ($0.time, Double($0.pods)) }, suffix: "", max: nil, color: ChartPalette.color(2))
                        Text("\(history.count) samples · refreshing every 10s")
                            .font(.caption2).foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    } else {
                        Text("Collecting metrics — graphs appear in a few seconds.")
                            .font(.footnote).foregroundStyle(.tertiary)
                    }
                }
            }
            .cardSurface()
        }
    }

    private func metric(_ label: String, _ value: String, tone: Tone? = nil) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value).font(.subheadline.weight(.medium).monospacedDigit()).foregroundStyle(tone?.textStyle ?? AnyShapeStyle(.primary)).lineLimit(1).minimumScaleFactor(0.8)
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func formatLoose(_ v: LooseDouble?) -> String {
        guard let d = v?.value else { return "?" }
        return d == d.rounded() ? String(Int(d)) : fmt1(d)
    }

    private func fmt1(_ d: Double) -> String { String(format: "%.1f", d) }
}

/// A compact single-series line-with-area chart for the metrics history.
private struct MiniLine: View {
    let label: String
    let values: [(Date, Double)]
    let suffix: String
    let max: Double?
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(label).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text("\(Int(values.last?.1 ?? 0))\(suffix)").font(.caption.weight(.medium).monospacedDigit()).contentTransition(.numericText())
            }
            Chart {
                ForEach(Array(values.enumerated()), id: \.offset) { _, v in
                    AreaMark(x: .value("Time", v.0), y: .value(label, v.1))
                        .foregroundStyle(color.opacity(ChartPalette.areaOpacity))
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("Time", v.0), y: .value(label, v.1))
                        .foregroundStyle(color)
                        .lineStyle(StrokeStyle(lineWidth: 1.5))
                        .interpolationMethod(.monotone)
                }
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartYScale(domain: 0...(max ?? Swift.max(values.map(\.1).max() ?? 1, 1)))
            .frame(height: 44)
        }
    }
}

// MARK: - Recent tasks (recent-tasks.tsx)

private struct RecentTaskRow: View {
    let task: DashRecentTask

    private var trailing: (String, Tone?)? {
        switch task.state {
        case "completed": return ("Done", nil)
        case "failed": return ("Failed", .danger)
        case "needs_attention": return ("Needs you", .accent)
        case "cancelled": return ("Cancelled", nil)
        default: return (task.createdAt?.relativeDescription ?? "", nil)
        }
    }

    var body: some View {
        OptioRow(
            title: task.title ?? "Untitled",
            tone: Tone.forState(task.state),
            meta: Text.meta([
                task.repoUrl.map { InsightsFormat.repoShortName($0) },
                task.agentType.map { RunFormatting.agentLabel($0) },
                Cost.formatIfNonZero(task.cost),
            ]),
            trailing: trailing?.0,
            trailingTone: trailing?.1
        )
    }
}
