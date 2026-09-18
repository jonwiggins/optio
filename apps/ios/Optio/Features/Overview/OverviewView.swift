import Charts
import SwiftUI

/// The Overview tab. Mirrors `apps/web/src/app/page.tsx`: pipeline stat strips for
/// Tasks / Jobs / Agents / Sessions, Claude usage, cluster summary, active sessions,
/// and recent tasks. Polls every 10 seconds while visible.
struct OverviewView: View {
    @Environment(APIClient.self) private var api
    @State private var model = OverviewModel()

    var body: some View {
        NavigationStack {
            Group {
                if model.loading, model.taskStats == nil {
                    if let error = model.error {
                        ErrorBanner(error: error) { Task { await model.refresh(api: api) } }
                    } else {
                        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                } else if model.isFirstRun {
                    welcome
                } else {
                    content
                }
            }
            .navigationTitle("Overview")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await model.refresh(api: api) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
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
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                subtitle
                if let error = model.error {
                    ErrorBanner(error: error) { Task { await model.refresh(api: api) } }
                }

                StatsSection(title: "Tasks", systemImage: "arrow.triangle.pull", destination: .tasks) {
                    OverviewStatsStrip(stages: taskStages(model.taskStats))
                }

                if let s = model.standaloneStats, s.total > 0 {
                    StatsSection(title: "Jobs", systemImage: "terminal", destination: .jobs) {
                        OverviewStatsStrip(stages: standaloneStages(s))
                    }
                }

                if let s = model.agentStats, s.total > 0 {
                    StatsSection(title: "Agents", systemImage: "cpu", destination: .agents) {
                        OverviewStatsStrip(stages: agentStages(s))
                    }
                }

                if let s = model.sessionStats, s.total > 0 {
                    StatsSection(title: "Sessions", systemImage: "bubble.left.and.bubble.right", destination: .sessions) {
                        OverviewStatsStrip(stages: sessionStages(s))
                    }
                }

                UsagePanelView(usage: model.usage) {
                    await model.refreshUsage(api: api)
                }

                ClusterSummaryCard(
                    cluster: model.cluster,
                    forbidden: model.clusterForbidden,
                    totalCost: model.totalRecentCost,
                    history: model.metricsHistory
                )

                if !model.activeSessions.isEmpty {
                    ActiveSessionsSection(sessions: model.activeSessions, activeCount: model.activeSessionCount)
                }

                RecentTasksSection(tasks: model.recentTasks)
            }
            .padding()
        }
        .refreshable { await model.refresh(api: api) }
    }

    private var subtitle: some View {
        let running = model.taskStats?.running ?? 0
        let attention = model.taskStats?.needsAttention ?? 0
        return HStack(spacing: 6) {
            Text("\(running) active \(running == 1 ? "task" : "tasks")")
            if model.activeSessionCount > 0 {
                Text("·").foregroundStyle(.tertiary)
                Text("\(model.activeSessionCount) \(model.activeSessionCount == 1 ? "session" : "sessions")")
                    .foregroundStyle(AppTheme.accent)
            }
            if attention > 0 {
                Text("·").foregroundStyle(.tertiary)
                Text("\(attention) need\(attention == 1 ? "s" : "") attention")
                    .foregroundStyle(.yellow)
            }
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }

    private var welcome: some View {
        ScrollView {
            VStack(spacing: 16) {
                Image(systemName: "sparkles")
                    .font(.system(size: 40))
                    .foregroundStyle(AppTheme.accent)
                Text("Welcome to Optio").font(.title2.weight(.semibold))
                Text(model.repoCount == 0
                     ? "Add a repository from the web UI, then create your first task to get an AI agent working on your code."
                     : "\(model.repoCount ?? 0) \(model.repoCount == 1 ? "repo" : "repos") connected. Create your first task from the Run tab.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                UsagePanelView(usage: model.usage) { await model.refreshUsage(api: api) }
            }
            .padding()
            .frame(maxWidth: .infinity)
        }
        .refreshable { await model.refresh(api: api) }
    }

    // MARK: Stages (pipeline-stats-bar.tsx)

    private func taskStages(_ s: DashTaskStats?) -> [OverviewStage] {
        [
            OverviewStage(key: "queue", label: "Queue", value: s?.queued ?? 0, icon: "list.bullet", color: .secondary),
            OverviewStage(key: "running", label: "Running", value: s?.running ?? 0, icon: "waveform.path.ecg", color: AppTheme.accent),
            OverviewStage(key: "ci", label: "CI", value: s?.ci ?? 0, icon: "arrow.triangle.merge", color: .blue),
            OverviewStage(key: "review", label: "Review", value: s?.review ?? 0, icon: "eye", color: .blue),
            OverviewStage(key: "attention", label: "Attention", value: s?.needsAttention ?? 0, icon: "exclamationmark.triangle", color: .yellow),
            OverviewStage(key: "failed", label: "Failed", value: s?.failed ?? 0, icon: "xmark.octagon", color: .red),
            OverviewStage(key: "done", label: "Done", value: s?.completed ?? 0, icon: "checkmark.circle", color: .green),
        ]
    }

    private func standaloneStages(_ s: DashJobStats) -> [OverviewStage] {
        [
            OverviewStage(key: "queue", label: "Queue", value: s.queued, icon: "list.bullet", color: .secondary),
            OverviewStage(key: "running", label: "Running", value: s.running, icon: "waveform.path.ecg", color: AppTheme.accent),
            OverviewStage(key: "failed", label: "Failed", value: s.failed, icon: "xmark.octagon", color: .red),
            OverviewStage(key: "done", label: "Done", value: s.completed, icon: "checkmark.circle", color: .green),
        ]
    }

    private func agentStages(_ s: DashAgentStats) -> [OverviewStage] {
        [
            OverviewStage(key: "idle", label: "Idle", value: s.idle, icon: "moon", color: .secondary),
            OverviewStage(key: "queue", label: "Queue", value: s.queued, icon: "list.bullet", color: .secondary),
            OverviewStage(key: "running", label: "Running", value: s.running, icon: "waveform.path.ecg", color: AppTheme.accent),
            OverviewStage(key: "paused", label: "Paused", value: s.paused, icon: "pause", color: .yellow),
            OverviewStage(key: "failed", label: "Failed", value: s.failed, icon: "xmark.octagon", color: .red),
            OverviewStage(key: "archived", label: "Archived", value: s.archived, icon: "archivebox", color: .secondary),
        ]
    }

    private func sessionStages(_ s: DashSessionStats) -> [OverviewStage] {
        [
            OverviewStage(key: "active", label: "Active", value: s.active, icon: "waveform.path.ecg", color: AppTheme.accent),
            OverviewStage(key: "ended", label: "Ended (24h)", value: s.ended, icon: "xmark.circle", color: .secondary),
        ]
    }
}

// MARK: - Stats strip

struct OverviewStage: Identifiable {
    let key: String
    let label: String
    let value: Int
    let icon: String
    let color: Color
    var id: String { key }
}

private struct StatsSection<Content: View>: View {
    let title: String
    let systemImage: String
    var destination: AppRouter.Section? = nil
    @ViewBuilder let content: Content
    @Environment(AppRouter.self) private var router

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                if let destination { router.open(destination) }
            } label: {
                HStack(spacing: 4) {
                    Label(title, systemImage: systemImage)
                    if destination != nil {
                        Image(systemName: "chevron.right").font(.caption2)
                    }
                    Spacer()
                }
                .font(.caption.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .disabled(destination == nil)
            content
        }
    }
}

/// Big mono numbers with an icon + uppercase label, one cell per pipeline stage.
struct OverviewStatsStrip: View {
    let stages: [OverviewStage]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(stages) { stage in
                    let active = stage.value > 0
                    VStack(spacing: 6) {
                        Text("\(stage.value)")
                            .font(.system(.title, design: .monospaced).weight(.bold))
                            .foregroundStyle(active ? stage.color : Color.secondary.opacity(0.3))
                        HStack(spacing: 4) {
                            Image(systemName: stage.icon)
                            Text(stage.label)
                        }
                        .font(.caption2.weight(.semibold))
                        .textCase(.uppercase)
                        .foregroundStyle(active ? stage.color : .secondary)
                    }
                    .frame(minWidth: 84)
                    .padding(.vertical, 14)
                    .padding(.horizontal, 8)
                    .overlay(alignment: .top) {
                        if active {
                            Rectangle().fill(stage.color).frame(height: 2)
                        }
                    }
                }
            }
        }
        .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Usage panel (usage-panel.tsx)

struct UsagePanelView: View {
    let usage: ClaudeUsageData?
    let onRefresh: () async -> Void

    var body: some View {
        if let usage {
            if usage.claudeAuthFailed || usage.githubAuthFailed {
                VStack(spacing: 8) {
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
                VStack(alignment: .leading, spacing: 12) {
                    Label("Claude Max Usage", systemImage: "gauge.with.needle")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    let meters = self.meters(usage)
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
                        ForEach(meters, id: \.label) { m in
                            ClaudeUsageMeter(label: m.label, utilization: m.utilization, resetsAt: m.resetsAt, sublabel: m.sublabel)
                        }
                    }
                }
                .padding(12)
                .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 12))
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
            let spent = String(format: "$%.2f", used / 100)
            let sub = x.monthlyLimit.map { "\(spent) / \(String(format: "$%.2f", $0 / 100)) spent" } ?? "\(spent) spent"
            out.append(Meter(label: "Extra Credits", utilization: x.utilization ?? 0, resetsAt: nil, sublabel: sub))
        }
        return out
    }

    private func tokenBanner(title: String, message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "key.slash").foregroundStyle(.red)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(message).font(.caption).foregroundStyle(.secondary)
                Button("Re-check") { Task { await onRefresh() } }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.red.opacity(0.25)))
    }
}

struct ClaudeUsageMeter: View {
    let label: String
    let utilization: Double
    let resetsAt: String?
    var sublabel: String? = nil

    private var pct: Double { min(max(utilization, 0), 100) }
    private var color: Color { pct >= 80 ? .red : pct >= 50 ? .yellow : AppTheme.accent }

    private var resetLabel: String? {
        guard let resetsAt, let date = resetsAt.isoDate else { return nil }
        let diff = date.timeIntervalSinceNow
        guard diff > 0 else { return nil }
        let h = Int(diff / 3600)
        let m = Int(diff.truncatingRemainder(dividingBy: 3600) / 60)
        return h > 0 ? "\(h)h \(m)m" : "\(m)m"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                Spacer()
                Text("\(Int(pct.rounded()))%").font(.caption.weight(.semibold).monospacedDigit()).foregroundStyle(color)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.fill.secondary)
                    Capsule().fill(color).frame(width: geo.size.width * pct / 100)
                }
            }
            .frame(height: 6)
            if let sublabel {
                Text(sublabel).font(.caption2).foregroundStyle(.tertiary)
            }
            if let resetLabel {
                Label("resets in \(resetLabel)", systemImage: "clock")
                    .font(.caption2).foregroundStyle(.tertiary)
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
            HStack(spacing: 8) {
                Image(systemName: "lock").foregroundStyle(.secondary)
                Text("Cluster summary is available to workspace admins.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 12))
        } else if let cluster {
            let s = cluster.summary
            let node = cluster.nodes.first
            VStack(alignment: .leading, spacing: 10) {
                if let node {
                    HStack(spacing: 4) {
                        Text(node.name).font(.caption.monospaced())
                        Text("/ optio").font(.caption).foregroundStyle(.tertiary)
                    }
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 14) {
                        metric(icon: "circle.fill", iconColor: s.readyNodes > 0 ? .green : .red, label: "Nodes", value: "\(s.readyNodes)/\(s.totalNodes)")
                        metric(icon: "shippingbox", label: "Pods", value: "\(s.runningPods)/\(s.totalPods)")
                        metric(icon: "waveform.path.ecg", label: "Agents", value: "\(s.agentPods)")
                        metric(icon: "cylinder", label: "Infra", value: "\(s.infraPods)")
                        if let node {
                            if let cpu = node.cpuPercent?.value {
                                metric(icon: "cpu", label: "CPU", value: "\(Int(cpu))% of \(formatLoose(node.cpu)) cores")
                            } else {
                                metric(icon: "cpu", label: "CPU", value: "N/A · \(formatLoose(node.cpu)) cores")
                            }
                            if let used = node.memoryUsedGi?.value {
                                metric(icon: "memorychip", label: "Mem", value: "\(fmt1(used)) / \(fmt1(node.memoryTotalGi?.value ?? 0)) Gi")
                            } else {
                                metric(icon: "memorychip", label: "Mem", value: "N/A · \(InsightsFormat.k8sResource(node.memory))")
                            }
                        }
                        if totalCost > 0 {
                            metric(icon: "dollarsign", label: "Recent", value: String(format: "$%.2f", totalCost))
                        }
                    }
                }
                if node != nil {
                    Button {
                        withAnimation { showMetrics.toggle() }
                    } label: {
                        Label(showMetrics ? "Hide metrics" : "Show metrics", systemImage: showMetrics ? "chevron.up" : "chart.xyaxis.line")
                            .font(.caption)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                }
                if showMetrics {
                    Divider()
                    if cluster.metricsAvailable == false {
                        Text("metrics-server not detected — CPU and memory charts unavailable.")
                            .font(.caption).foregroundStyle(.tertiary)
                    } else if history.count > 1 {
                        MiniLine(label: "CPU", values: history.map { ($0.time, $0.cpuPercent ?? 0) }, suffix: "%", max: 100, color: AppTheme.accent)
                        MiniLine(label: "Memory", values: history.map { ($0.time, $0.memoryPercent ?? 0) }, suffix: "%", max: 100, color: .blue)
                        MiniLine(label: "Pods", values: history.map { ($0.time, Double($0.pods)) }, suffix: "", max: nil, color: .green)
                        Text("\(history.count) samples · refreshing every 10s")
                            .font(.caption2).foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    } else {
                        Text("Collecting metrics data… graphs will appear in a few seconds.")
                            .font(.caption).foregroundStyle(.tertiary)
                    }
                }
            }
            .padding(12)
            .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private func metric(icon: String, iconColor: Color = .secondary, label: String, value: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon).font(.caption2).foregroundStyle(iconColor)
            Text(label).foregroundStyle(.secondary)
            Text(value).fontWeight(.medium).monospacedDigit()
        }
        .font(.caption)
        .lineLimit(1)
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
                Text(label).font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                Spacer()
                Text("\(Int(values.last?.1 ?? 0))\(suffix)").font(.caption2.weight(.medium).monospacedDigit())
            }
            Chart {
                ForEach(Array(values.enumerated()), id: \.offset) { _, v in
                    AreaMark(x: .value("Time", v.0), y: .value(label, v.1))
                        .foregroundStyle(color.opacity(0.15))
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("Time", v.0), y: .value(label, v.1))
                        .foregroundStyle(color)
                        .lineStyle(StrokeStyle(lineWidth: 2))
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


// MARK: - Active sessions (active-sessions.tsx)

private struct ActiveSessionsSection: View {
    let sessions: [DashSessionRow]
    let activeCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "terminal").foregroundStyle(AppTheme.accent)
                Text("Active Sessions").font(.subheadline.weight(.medium))
                Text("\(activeCount)")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(AppTheme.accent.opacity(0.15), in: RoundedRectangle(cornerRadius: 6))
                    .foregroundStyle(AppTheme.accent)
            }
            ForEach(sessions) { s in
                HStack(spacing: 10) {
                    Image(systemName: "terminal")
                        .frame(width: 32, height: 32)
                        .background(AppTheme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                        .foregroundStyle(AppTheme.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.branch ?? "Session \(s.id.prefix(8))").font(.caption.weight(.medium)).lineLimit(1)
                        HStack(spacing: 6) {
                            Label(InsightsFormat.repoShortName(s.repoUrl ?? ""), systemImage: "folder")
                            if let c = s.createdAt { Text(c.relativeDescription) }
                        }
                        .font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Circle().fill(AppTheme.accent).frame(width: 8, height: 8)
                }
                .padding(10)
                .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 10))
            }
            Text("Open the Live tab for the full session view.")
                .font(.caption2).foregroundStyle(.tertiary)
        }
    }
}

// MARK: - Recent tasks (recent-tasks.tsx)

private struct RecentTasksSection: View {
    let tasks: [DashRecentTask]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Recent Tasks").font(.subheadline.weight(.medium))
            if tasks.isEmpty {
                EmptyState(title: "No tasks yet", systemImage: "list.bullet.rectangle", message: "Create a task from the Run tab to get an agent working on your code.")
            } else {
                ForEach(tasks) { task in
                    NavigationLink(value: task) {
                        RecentTaskRow(task: task)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .navigationDestination(for: DashRecentTask.self) { RecentTaskSummaryView(task: $0) }
    }
}

private struct RecentTaskRow: View {
    let task: DashRecentTask

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(task.title ?? "Untitled").font(.subheadline.weight(.medium)).lineLimit(2)
                HStack(spacing: 6) {
                    if let repo = task.repoUrl { Text(InsightsFormat.repoShortName(repo)) }
                    if let agent = task.agentType { Text("·"); Text(agent.replacingOccurrences(of: "-", with: " ")) }
                    if let c = task.createdAt { Text("·"); Text(c.relativeDescription) }
                }
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                StatusBadge(text: task.state ?? "unknown", color: StateColor.color(for: task.state ?? ""))
                if task.cost > 0 {
                    Text(String(format: "$%.2f", task.cost)).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
        }
        .padding(10)
        .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 10))
    }
}

/// Detail-less summary for a recent task. Full task detail lives on the Run tab;
/// a cross-tab router in Core would let this push into it directly.
struct RecentTaskSummaryView: View {
    let task: DashRecentTask

    var body: some View {
        List {
            Section {
                LabeledContent("State") { StatusBadge(text: task.state ?? "unknown", color: StateColor.color(for: task.state ?? "")) }
                if let repo = task.repoUrl { LabeledContent("Repo", value: InsightsFormat.repoShortName(repo)) }
                if let b = task.repoBranch { LabeledContent("Branch", value: b) }
                if let a = task.agentType { LabeledContent("Agent", value: a) }
                if task.cost > 0 { LabeledContent("Cost", value: String(format: "$%.4f", task.cost)) }
                if let c = task.createdAt { LabeledContent("Created", value: c.relativeDescription) }
            }
            if let pr = task.prUrl, let url = URL(string: pr) {
                Section("Pull request") {
                    Link(destination: url) { Label(pr, systemImage: "arrow.up.right.square").lineLimit(1) }
                }
            }
            if let err = task.errorMessage, !err.isEmpty {
                Section("Error") { Text(err).font(.caption.monospaced()).foregroundStyle(.red) }
            }
            if let summary = task.resultSummary, !summary.isEmpty {
                Section("Result") { Text(summary).font(.callout) }
            }
            Section {
                Text("Open the Run tab → Tasks for logs, comments, and actions.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .navigationTitle(task.title ?? "Task")
        .navigationBarTitleDisplayMode(.inline)
    }
}

