import Charts
import SwiftUI

@Observable
@MainActor
final class CostsModel {
    var days = 30
    var repoFilter: String? = nil
    var repos: [(url: String, name: String)] = []
    var data: CostAnalytics?
    var loading = false
    var error: Error?

    func load(api: APIClient) async {
        loading = true
        defer { loading = false }
        do {
            data = try await api.costAnalytics(days: days, repoUrl: repoFilter)
            error = nil
        } catch {
            self.error = error
        }
        if repos.isEmpty, let r = try? await api.repoUrls() { repos = r }
    }
}

/// Mirrors `apps/web/src/app/costs/page.tsx`.
struct CostsView: View {
    @Environment(APIClient.self) private var api
    @State private var model = CostsModel()

    private var filterKey: String { "\(model.days)|\(model.repoFilter ?? "")" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    PeriodPicker(days: $model.days)
                    Menu {
                        Button("All repos") { model.repoFilter = nil }
                        ForEach(model.repos, id: \.url) { r in
                            Button(r.name) { model.repoFilter = r.url }
                        }
                    } label: {
                        Label(model.repoFilter.map(InsightsFormat.repoShortName) ?? "All repos", systemImage: "line.3.horizontal.decrease.circle")
                            .font(.caption).lineLimit(1)
                    }
                }
                if let error = model.error, model.data == nil {
                    if error.isForbidden { AdminOnlyState(what: "Cost analytics") } else {
                        ErrorBanner(error: error) { Task { await model.load(api: api) } }
                    }
                } else if let d = model.data {
                    summary(d)
                    suggestions(d)
                    anomalies(d)
                    costOverTime(d)
                    byModel(d)
                    byRepo(d)
                    byType(d)
                    topTasks(d)
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                }
            }
            .padding()
        }
        .refreshable { await model.load(api: api) }
        .task(id: filterKey) { await model.load(api: api) }
    }

    // MARK: Summary

    private func summary(_ d: CostAnalytics) -> some View {
        let s = d.summary
        let f = d.forecast
        let trend = Double(s?.costTrend ?? "") ?? 0
        return LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                StatTile(title: "Total spend", value: InsightsFormat.cost(s?.totalCost), systemImage: "dollarsign")
                HStack(spacing: 4) {
                    if trend != 0 {
                        Label(String(format: "%@%.1f%%", trend > 0 ? "+" : "", trend), systemImage: trend > 0 ? "arrow.up.right" : "arrow.down.right")
                            .foregroundStyle(trend > 0 ? .red : .green)
                    }
                    Text("last \(s?.days ?? model.days)d").foregroundStyle(.secondary)
                }
                .font(.caption2).padding(.leading, 4)
            }
            sub(StatTile(title: "Average cost", value: InsightsFormat.cost(s?.avgCost), systemImage: "chart.bar"), "across \(s?.tasksWithCost ?? 0) tasks")
            sub(StatTile(title: "Monthly forecast", value: InsightsFormat.cost(f?.forecastedMonthTotal), systemImage: "calendar"), "\(InsightsFormat.cost(f?.monthCostSoFar)) spent · \(f?.daysRemaining ?? 0)d left")
            sub(StatTile(title: "Prev period", value: InsightsFormat.cost(s?.prevPeriodCost), systemImage: "dollarsign"), "previous \(s?.days ?? model.days)d")
        }
    }

    private func sub(_ tile: StatTile, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            tile
            Text(text).font(.caption2).foregroundStyle(.secondary).padding(.leading, 4)
        }
    }

    // MARK: Banners

    @ViewBuilder
    private func suggestions(_ d: CostAnalytics) -> some View {
        if let s = d.modelSuggestions, !s.isEmpty {
            banner(icon: "lightbulb", color: .yellow, title: "Cost optimization suggestions") {
                ForEach(Array(s.enumerated()), id: \.offset) { _, x in
                    let avg = x.avgCost ?? 0
                    let cheaper = x.cheaperModelAvgCost ?? 0
                    let savings = avg - cheaper
                    let pct = avg > 0 ? savings / avg * 100 : 0
                    Text("\(InsightsFormat.repoShortName(x.repoUrl)): \(x.taskCount ?? 0) tasks ran with \(InsightsFormat.modelShortName(x.currentModel)) (avg \(InsightsFormat.cost(avg))). ")
                        + Text(cheaper > 0 ? "Try Sonnet to save ~\(Int(pct))% (\(InsightsFormat.cost(savings))/task)." : "Consider trying Sonnet for potential savings.")
                }
            }
        }
    }

    @ViewBuilder
    private func anomalies(_ d: CostAnalytics) -> some View {
        if let a = d.anomalies, !a.isEmpty {
            banner(icon: "exclamationmark.triangle", color: .red, title: "Cost anomalies (\(a.count))") {
                Text("These tasks cost 3x or more than the repository average:").foregroundStyle(.secondary)
                ForEach(a.prefix(5)) { x in
                    HStack(spacing: 6) {
                        Text(x.title ?? x.id).lineLimit(1)
                        Text(InsightsFormat.cost(x.costUsd)).foregroundStyle(.red).fontWeight(.medium)
                        Text(String(format: "(%.1fx avg of %@)", x.costRatio ?? 0, InsightsFormat.cost(x.repoAvgCost))).foregroundStyle(.secondary)
                    }
                }
                if a.count > 5 { Text("+\(a.count - 5) more anomalies").foregroundStyle(.secondary) }
            }
        }
    }

    private func banner<Content: View>(icon: String, color: Color, title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).foregroundStyle(color)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.medium))
                content().font(.caption)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(color.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(color.opacity(0.25)))
    }

    // MARK: Charts

    private func costOverTime(_ d: CostAnalytics) -> some View {
        let rows = (d.dailyCosts ?? []).compactMap { p -> (Date, Double)? in
            guard let day = InsightsFormat.day(p.date) else { return nil }
            return (day, p.cost ?? 0)
        }
        return InsightCard(title: "Cost over time") {
            if rows.isEmpty {
                Text("No cost data for this period").font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 120)
            } else {
                Chart(Array(rows.enumerated()), id: \.offset) { _, r in
                    AreaMark(x: .value("Day", r.0), y: .value("Cost", r.1))
                        .foregroundStyle(AppTheme.accent.opacity(0.15))
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("Day", r.0), y: .value("Cost", r.1))
                        .foregroundStyle(AppTheme.accent)
                        .lineStyle(StrokeStyle(lineWidth: 2))
                        .interpolationMethod(.monotone)
                }
                .chartXAxis { AxisMarks(values: .automatic(desiredCount: 5)) { _ in AxisGridLine(); AxisValueLabel(format: .dateTime.month(.abbreviated).day()) } }
                .chartYAxis { AxisMarks(position: .leading) { v in
                    AxisGridLine()
                    AxisValueLabel { if let x = v.as(Double.self) { Text("$\(x, specifier: "%.0f")") } }
                } }
                .frame(height: 200)
            }
        }
    }

    @ViewBuilder
    private func byModel(_ d: CostAnalytics) -> some View {
        if let models = d.costByModel, !models.isEmpty {
            let maxCost = models.map { $0.totalCost ?? 0 }.max() ?? 1
            InsightCard(title: "Cost by model", systemImage: "cpu") {
                ForEach(models) { m in
                    VStack(alignment: .leading, spacing: 2) {
                        RateBar(label: InsightsFormat.modelShortName(m.model), valueText: InsightsFormat.cost(m.totalCost), fraction: (m.totalCost ?? 0) / max(maxCost, 0.0001))
                        HStack {
                            Text("\(m.taskCount ?? 0) tasks · \(Int(m.successRate ?? 0))% success")
                            Spacer()
                            Text("avg \(InsightsFormat.cost(m.avgCost))")
                        }
                        .font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func byRepo(_ d: CostAnalytics) -> some View {
        if let repos = d.costByRepo, !repos.isEmpty {
            let maxCost = repos.map { $0.totalCost ?? 0 }.max() ?? 1
            InsightCard(title: "Cost by repository") {
                ForEach(repos) { r in
                    RateBar(label: InsightsFormat.repoShortName(r.repoUrl), valueText: "\(InsightsFormat.cost(r.totalCost)) (\(r.taskCount ?? 0))", fraction: (r.totalCost ?? 0) / max(maxCost, 0.0001))
                }
            }
        }
    }

    @ViewBuilder
    private func byType(_ d: CostAnalytics) -> some View {
        if let types = d.costByType, !types.isEmpty {
            let total = types.reduce(0) { $0 + ($1.totalCost ?? 0) }
            InsightCard(title: "Cost by task type") {
                Chart(types) { t in
                    BarMark(x: .value("Cost", t.totalCost ?? 0))
                        .foregroundStyle(by: .value("Type", t.taskType))
                }
                .chartForegroundStyleScale(domain: types.map(\.taskType), range: [AppTheme.accent, Color.blue, Color.gray, Color.teal].prefix(types.count).map { $0 })
                .chartXAxis(.hidden)
                .chartLegend(.hidden)
                .frame(height: 28)
                ForEach(Array(types.enumerated()), id: \.offset) { i, t in
                    HStack(spacing: 6) {
                        Circle().fill([AppTheme.accent, Color.blue, Color.gray, Color.teal][i % 4]).frame(width: 8, height: 8)
                        Text(t.taskType)
                        Spacer()
                        Text("\(InsightsFormat.cost(t.totalCost)) (\(t.taskCount ?? 0))").foregroundStyle(.secondary)
                        Text(total > 0 ? "\(Int(((t.totalCost ?? 0) / total * 100).rounded()))%" : "").foregroundStyle(.tertiary).monospacedDigit()
                    }
                    .font(.caption)
                }
            }
        }
    }

    // MARK: Table

    private func topTasks(_ d: CostAnalytics) -> some View {
        let tasks = d.topTasks ?? []
        let anomalyIds = Set((d.anomalies ?? []).map(\.id))
        return InsightCard(title: "Most expensive tasks") {
            if tasks.isEmpty {
                Text("No tasks with cost data").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(tasks) { t in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .top) {
                            if anomalyIds.contains(t.id) {
                                Image(systemName: "exclamationmark.triangle").font(.caption).foregroundStyle(.red)
                            }
                            Text(t.title ?? t.id).font(.subheadline).lineLimit(2)
                            Spacer()
                            Text(InsightsFormat.cost(t.costUsd)).font(.subheadline.weight(.semibold).monospacedDigit())
                        }
                        HStack(spacing: 6) {
                            if let r = t.repoUrl { Text(InsightsFormat.repoShortName(r)) }
                            StatusBadge(text: InsightsFormat.modelShortName(t.modelUsed), color: AppTheme.accent)
                            if let tt = t.taskType { StatusBadge(text: tt, color: tt == "review" ? .blue : AppTheme.accent) }
                            if let s = t.state { Text(s) }
                            Spacer()
                            if (t.inputTokens ?? 0) > 0 || (t.outputTokens ?? 0) > 0 {
                                Text("\(InsightsFormat.tokens(t.inputTokens)) / \(InsightsFormat.tokens(t.outputTokens))").monospacedDigit()
                            }
                            if let c = t.createdAt { Text(c.relativeDescription) }
                        }
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .padding(.vertical, 6)
                    .background(anomalyIds.contains(t.id) ? Color.red.opacity(0.05) : .clear)
                    if t.id != tasks.last?.id { Divider() }
                }
            }
        }
    }
}
