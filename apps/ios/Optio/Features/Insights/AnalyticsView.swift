import Charts
import SwiftUI

@Observable
@MainActor
final class AnalyticsModel {
    var days = 30
    var performance: PerformanceAnalytics?
    var agents: AgentAnalytics?
    var failures: FailureAnalytics?
    var prs: PrAnalytics?
    var loading = false
    var error: Error?

    func load(api: APIClient) async {
        loading = true
        defer { loading = false }
        let d = days
        async let perf = api.performanceAnalytics(days: d)
        async let ag = api.agentAnalytics(days: d)
        async let fail = api.failureAnalytics(days: d)
        async let pr = api.prAnalytics(days: d)
        do {
            let (p, a, f, r) = try await (perf, ag, fail, pr)
            performance = p; agents = a; failures = f; prs = r
            error = nil
        } catch {
            self.error = error
        }
    }
}

/// Mirrors `apps/web/src/app/analytics/page.tsx`.
struct AnalyticsView: View {
    @Environment(APIClient.self) private var api
    @State private var model = AnalyticsModel()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.l) {
                if let error = model.error, model.performance == nil {
                    if error.isForbidden { AdminOnlyState(what: "Analytics") } else {
                        ErrorRow(error: error, what: "analytics") { Task { await model.load(api: api) } }
                    }
                } else if model.loading, model.performance == nil {
                    SkeletonStrip(labels: ["Success", "Avg duration", "Queue wait", "PR merge"])
                } else {
                    summaryTiles
                    tasksOverTime
                    agentComparison
                    failureBreakdown
                    failureByRepoAndModel
                    prFunnel
                }
            }
            .padding()
        }
        .background(Surface.page)
        .dimmedWhileLoading(model.loading && model.performance != nil)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { PeriodPicker(days: $model.days).fixedSize() } }
        .refreshable { await model.load(api: api) }
        .task(id: model.days) { await model.load(api: api) }
    }

    // MARK: Summary

    private var summaryTiles: some View {
        let p = model.performance
        let trend = p?.successRateTrend ?? 0
        return VStack(alignment: .leading, spacing: Spacing.s) {
            StatStrip(items: [
                StatItem("Success", text: InsightsFormat.percent(p?.successRate ?? 0)),
                StatItem("Avg duration", text: InsightsFormat.duration(p?.durations?.avgExecution)),
                StatItem("Queue wait", text: InsightsFormat.duration(p?.durations?.avgQueueWait)),
                StatItem("PR merge", text: InsightsFormat.percent(model.prs?.autoMergeRate ?? 0)),
            ])
            Text.meta([
                trend != 0 ? "\(trend > 0 ? "+" : "")\(Int(trend))pp vs previous" : nil,
                "p95 \(InsightsFormat.duration(p?.durations?.p95Execution))",
                "\(p?.durations?.taskCount ?? 0) completed",
                "\(model.prs?.merged ?? 0) of \(model.prs?.totalPrs ?? 0) PRs merged",
            ])
            .font(.caption).foregroundStyle(.secondary)
        }
    }

    // MARK: Tasks over time (stacked bars, succeeded + failed)

    @ViewBuilder
    private var tasksOverTime: some View {
        if let points = model.performance?.tasksPerDay, !points.isEmpty {
            let rows = points.compactMap { p -> (Date, Int, Int)? in
                guard let d = InsightsFormat.day(p.date) else { return nil }
                return (d, p.succeeded ?? 0, p.failed ?? 0)
            }
            InsightCard(title: "Tasks over time") {
                Chart {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                        BarMark(x: .value("Day", r.0, unit: .day), y: .value("Tasks", r.1))
                            .foregroundStyle(by: .value("Outcome", "Succeeded"))
                        BarMark(x: .value("Day", r.0, unit: .day), y: .value("Tasks", r.2))
                            .foregroundStyle(by: .value("Outcome", "Failed"))
                    }
                }
                .chartForegroundStyleScale(["Succeeded": ChartPalette.color(1), "Failed": Color.red.opacity(0.8)])
                .chartLegend(position: .top, alignment: .leading)
                .chartXAxis { AxisMarks(values: .automatic(desiredCount: 5)) { _ in AxisGridLine(); AxisValueLabel(format: .dateTime.month(.abbreviated).day()) } }
                .chartYAxis { AxisMarks(position: .leading) { _ in AxisGridLine(); AxisValueLabel() } }
                .frame(height: ChartPalette.primaryHeight)
            }
        }
    }

    // MARK: Agent comparison

    @ViewBuilder
    private var agentComparison: some View {
        if let agents = model.agents?.agents, !agents.isEmpty {
            InsightCard(title: "Agent comparison", systemImage: "person.2") {
                VStack(spacing: 0) {
                    ForEach(agents) { a in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text((a.agentType ?? "?").capitalized).font(.subheadline.weight(.medium))
                                Spacer()
                                Text("\(a.taskCount ?? 0) tasks").font(.caption).foregroundStyle(.secondary)
                                let rate = a.successRate ?? 0
                                Text(InsightsFormat.percent(rate))
                                    .font(.caption.weight(.semibold).monospacedDigit())
                                    .foregroundStyle(rate < 50 ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
                            }
                            HStack(spacing: 10) {
                                Label(InsightsFormat.duration(a.avgDuration), systemImage: "clock")
                                Label(InsightsFormat.cost(a.avgCost), systemImage: "dollarsign")
                                Label(String(format: "%.1f retries", a.avgRetries ?? 0), systemImage: "arrow.clockwise")
                            }
                            .font(.caption2).foregroundStyle(.secondary)
                            if let models = a.models, !models.isEmpty {
                                Text(models.map { InsightsFormat.modelShortName($0.model) }.joined(separator: ", "))
                                    .font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                        .padding(.vertical, 8)
                        if a.id != agents.last?.id { Divider() }
                    }
                }
            }
        }
    }

    // MARK: Failures

    @ViewBuilder
    private var failureBreakdown: some View {
        if let f = model.failures, let msgs = f.errorMessages, !msgs.isEmpty {
            let top = Array(msgs.sorted { $0.count > $1.count }.prefix(8))
            InsightCard(title: "Failure breakdown", systemImage: "exclamationmark.triangle") {
                Chart(Array(top.enumerated()), id: \.offset) { _, m in
                    BarMark(x: .value("Count", m.count), y: .value("Error", Self.shortMessage(m.message)))
                        .foregroundStyle(ChartPalette.color(1))
                        .cornerRadius(3)
                        .annotation(position: .trailing, spacing: 4) {
                            Text("\(m.count)").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                        }
                }
                .chartXAxis(.hidden)
                .chartYAxis { AxisMarks { _ in AxisValueLabel().font(.caption2) } }
                .frame(height: CGFloat(max(Int(ChartPalette.secondaryHeight), top.count * 28)))

                Divider()
                HStack(spacing: 14) {
                    Label {
                        Text("Retry success ") + Text(InsightsFormat.percent(f.retrySuccessRate ?? 0)).bold() + Text(" (\(f.retrySucceededCount ?? 0)/\(f.retriedCount ?? 0))").foregroundStyle(.secondary)
                    } icon: { Image(systemName: "arrow.clockwise") }
                    if let stalls = f.stallCount, stalls > 0 {
                        Label {
                            Text("Stalls ") + Text("\(stalls)").bold() + Text(" (\(InsightsFormat.percent(f.stallRecoveryRate ?? 0)) recovered)").foregroundStyle(.secondary)
                        } icon: { Image(systemName: "bolt") }
                    }
                }
                .font(.caption)
            }
        }
    }

    private static func shortMessage(_ s: String) -> String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count > 28 ? String(t.prefix(27)) + "…" : t
    }

    @ViewBuilder
    private var failureByRepoAndModel: some View {
        if let f = model.failures {
            if let repos = f.failureByRepo, !repos.isEmpty {
                InsightCard(title: "Failure rate by repo") {
                    ForEach(repos.prefix(8), id: \.repoUrl) { r in
                        let rate = r.failureRate ?? 0
                        RateBar(label: InsightsFormat.repoShortName(r.repoUrl), valueText: "\(Int(rate))% (\(r.failed ?? 0)/\(r.total ?? 0))", fraction: rate / 100, color: rateColor(rate))
                    }
                }
            }
            if let models = f.failureByModel, !models.isEmpty {
                InsightCard(title: "Failure rate by model") {
                    ForEach(models, id: \.model) { m in
                        let rate = m.failureRate ?? 0
                        RateBar(label: m.model, valueText: "\(Int(rate))% (\(m.failed ?? 0)/\(m.total ?? 0))", fraction: rate / 100, color: rateColor(rate))
                    }
                }
            }
        }
    }

    private func rateColor(_ rate: Double) -> Color {
        rate >= 30 ? .red : ChartPalette.color(1)
    }

    // MARK: PR funnel

    @ViewBuilder
    private var prFunnel: some View {
        if let prs = model.prs, (prs.totalPrs ?? 0) > 0, let fn = prs.funnel {
            let opened = fn.prOpened ?? 0
            let steps: [(String, Int)] = [("PR opened", opened), ("CI passed", fn.ciPassed ?? 0), ("Review approved", fn.reviewApproved ?? 0), ("Merged", fn.merged ?? 0)]
            InsightCard(title: "PR lifecycle funnel", systemImage: "arrow.triangle.pull") {
                ForEach(Array(steps.enumerated()), id: \.offset) { i, step in
                    let pct = opened > 0 ? Double(step.1) / Double(opened) : 0
                    RateBar(label: step.0, valueText: i == 0 ? "\(step.1)" : "\(step.1) · \(Int((pct * 100).rounded()))%", fraction: pct, color: ChartPalette.color(i))
                }
                Divider()
                HStack(spacing: 12) {
                    Text("CI pass ") + Text(InsightsFormat.percent(prs.ciPassRate ?? 0)).bold()
                    Text("Review approval ") + Text(InsightsFormat.percent(prs.reviewApprovalRate ?? 0)).bold()
                    Text("Avg merge ") + Text(InsightsFormat.duration(prs.avgMergeTime)).bold()
                }
                .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
