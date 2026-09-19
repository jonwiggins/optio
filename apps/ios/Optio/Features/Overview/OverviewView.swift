import Charts
import SwiftUI

/// The Overview tab, a mirror of `apps/web/src/app/page.tsx` top to bottom:
/// header (title, feed-count subtitle, refresh, new session) → needs you →
/// usage limits → the sessions board (five tiles, active sessions, recurring +
/// persistent agents) → token banners → cluster summary → recent. The dashboard
/// model polls every 10 seconds while visible, the feed every 15, usage every 60.
struct OverviewView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppRouter.self) private var router
    @Environment(UsageStore.self) private var usage
    @State private var model = OverviewModel()
    @State private var feed: SessionsFeedModel?
    @State private var showNew = false

    var body: some View {
        NavigationStack {
            Group {
                if model.loading, model.taskStats == nil {
                    if let error = model.error {
                        List { ErrorRow(error: error, what: "the overview") { Task { await model.refresh(api: api) } } }.listStyle(.plain)
                    } else {
                        List {
                            Section { SkeletonStrip(labels: ["Need you", "Running", "Waiting", "Recurring", "Agents"]) }
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
            .serverSwitcherToolbar()
            .navigationDestination(for: DashRecentTask.self) { TaskDetailView(taskId: $0.id) }
            .navigationDestination(for: LocalRoute.self) { route in
                if case .terminal(let id) = route { LocalTerminalScreen(terminalId: id, hosts: model.localHosts) }
            }
            .sessionDestinations()
            .toolbar {
                ToolbarItemGroup(placement: .primaryAction) {
                    Button { Task { await refreshAll() } } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel("Refresh")
                    Button { showNew = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("New session")
                }
            }
            .sheet(isPresented: $showNew) { NewSessionSheet() }
            .observesUsage()
            .task {
                if feed == nil { feed = SessionsFeedModel(api: api) }
                feed?.start()
                while !Task.isCancelled {
                    await model.refresh(api: api)
                    try? await Task.sleep(for: .seconds(10))
                }
            }
            .onAppear { feed?.start() }
            .onDisappear { feed?.stop() }
        }
    }

    /// The header's refresh button: dashboard data, the feed and (fresh) usage at once.
    private func refreshAll() async {
        async let dash: Void = model.refresh(api: api)
        async let rows: Void = feed?.refresh() ?? ()
        async let limits: Bool = usage.refreshFresh()
        _ = await (dash, rows, limits)
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
                ActiveServerCard(hostsOnline: model.hasLocal ? model.localHostsOnline : nil, hostsTotal: model.hasLocal ? model.localHosts.count : nil)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                if let error = model.error {
                    ErrorRow(error: error, what: "the overview") { Task { await model.refresh(api: api) } }
                        .listRowBackground(Color.clear)
                }
            }

            needsYouSection

            if !usage.providerLimits.isEmpty {
                Section {
                    LimitsPanelView()
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }

            if let feed {
                SessionsBoardSections(feed: feed) { showNew = true }
            }

            if let u = usage.usage, u.claudeAuthFailed || u.githubAuthFailed {
                Section {
                    UsageTokenBanners()
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
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

            Section {
                if model.recentTasks.isEmpty {
                    EmptyState(title: "No tasks yet", systemImage: "checklist", message: "Start a session that opens a PR in one of your repos.", actionTitle: "New session") { showNew = true }
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(model.recentTasks) { task in
                        NavigationLink(value: task) { RecentTaskRow(task: task) }
                    }
                }
            } header: {
                SectionHeader(title: "Recent") { router.openSessions(.history) }.textCase(nil)
            }

            OtherServersSection()
        }
        .listStyle(.insetGrouped)
        .refreshable {
            await model.refresh(api: api)
            await feed?.refresh()
            await usage.refresh()
        }
    }

    /// The web's first section: everything waiting on you, whatever concept it
    /// belongs to (`needs-you.tsx`). Renders nothing when empty.
    @ViewBuilder private var needsYouSection: some View {
        let terminals = model.localNeedsYou
        let tasks = model.attentionTasks
        if !terminals.isEmpty || !tasks.isEmpty {
            Section {
                ForEach(terminals.prefix(4), id: \.id) { t in
                    NavigationLink(value: LocalRoute.terminal(id: t.id)) {
                        TerminalRowView(terminal: t, hostName: model.localHosts.count > 1 ? model.localHostName[t.hostId] : nil)
                    }
                }
                ForEach(tasks.prefix(3)) { task in
                    NavigationLink(value: task) {
                        OptioRow(
                            title: task.title ?? "Task \(task.id.prefix(8))",
                            tone: .accent,
                            meta: Text.meta([Text(InsightsFormat.repoShortName(task.repoUrl ?? "")), task.repoBranch.map { Text.mono($0) }]),
                            trailing: task.errorMessage ?? "needs attention",
                            trailingTone: .accent,
                            titleLineLimit: 1
                        )
                    }
                }
                if terminals.count > 4 {
                    Button("\(terminals.count - 4) more waiting in Sessions") { router.openSessions(.active) }.font(.footnote)
                }
            } header: {
                SectionHeader(title: "Needs you", detail: "\(terminals.count + tasks.count)", tone: .accent) { router.openSessions(.active) }.textCase(nil)
            }
        }
    }

    private var counts: SessionCounts { feed?.counts ?? SessionCounts() }

    /// "N running · N waiting for you · N need you · N recurring" (the web's page subtitle).
    private var subtitleText: String {
        let c = counts
        var s = "\(c.running) running"
        if c.waiting > 0 { s += " · \(c.waiting) waiting for you" }
        if c.needsYou > 0 { s += " · \(c.needsYou) need\(c.needsYou == 1 ? "s" : "") you" }
        if c.recurring > 0 { s += " · \(c.recurring) recurring" }
        return s
    }

    /// Same line for iOS < 26, with "waiting" in green and "need you" in accent.
    private var subtitle: some View {
        let c = counts
        return HStack(spacing: 6) {
            Text("\(c.running) running").contentTransition(.numericText())
            if c.waiting > 0 {
                Text("·").foregroundStyle(.tertiary)
                Text("\(c.waiting) waiting for you").foregroundStyle(Tone.success.textStyle)
            }
            if c.needsYou > 0 {
                Text("·").foregroundStyle(.tertiary)
                Text("\(c.needsYou) need\(c.needsYou == 1 ? "s" : "") you")
                    .foregroundStyle(Tone.accent.textStyle)
                    .contentTransition(.numericText())
            }
            if c.recurring > 0 {
                Text("·").foregroundStyle(.tertiary)
                Text("\(c.recurring) recurring")
            }
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }

    /// `welcome-hero.tsx`: a truly empty install (no tasks, no local terminals).
    private var welcome: some View {
        ScrollView {
            VStack(spacing: Spacing.l) {
                Image(systemName: "sparkles")
                    .font(.largeTitle.weight(.thin))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.secondary)
                Text("Welcome to Optio").font(.title2.weight(.semibold))
                Text(model.repoCount == 0
                     ? "Add a repository or pair a machine, then start your first session to get an AI agent working."
                     : "\(model.repoCount ?? 0) \(model.repoCount == 1 ? "repo" : "repos") connected. Start your first session.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                Button("New session") { showNew = true }.buttonStyle(.borderedProminent).tint(.primary)
                UsageTokenBanners()
            }
            .padding()
            .frame(maxWidth: .infinity)
        }
        .refreshable { await model.refresh(api: api) }
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
