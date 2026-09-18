import SwiftUI
import WidgetKit

/// "In Flight": what's running, read-only. Medium lists running items; large adds up
/// to three Repo Tasks in `running` / `pr_opened`. No buttons, no purple: nothing here
/// needs you (that's the other widget).
struct InFlightWidget: Widget {
    static let kind = WidgetKinds.inFlight

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: GlanceTimelineProvider(includeTasks: true)) { entry in
            InFlightView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("In Flight")
        .description("Agents and tasks that are running.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

struct InFlightView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry

    private var rowLimit: Int { family == .systemLarge ? 5 : 3 }

    var body: some View {
        if entry.reachability == .signedOut {
            SignedOutView()
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: GlanceStyle.glyph).symbolRenderingMode(.hierarchical).foregroundStyle(.secondary)
                    if entry.running.isEmpty {
                        Text("Nothing running").foregroundStyle(.secondary)
                    } else {
                        Text("\(entry.running.count)").contentTransition(.numericText()).foregroundStyle(.primary)
                        Text("running").foregroundStyle(.secondary)
                    }
                    if entry.count > 0 {
                        Text("· \(entry.count) need\(entry.count == 1 ? "s" : "") you").foregroundStyle(.secondary)
                    }
                    Spacer()
                    HonestyFooter(entry: entry)
                }
                .font(.subheadline.weight(.semibold))
                if entry.running.isEmpty {
                    Text("Quiet.").font(.footnote).foregroundStyle(.tertiary)
                } else {
                    ForEach(entry.running.prefix(rowLimit)) { item in
                        Link(destination: URL(string: item.link) ?? DeepLink.section("local").url) {
                            RunningRow(item: item)
                        }
                    }
                }
                if family == .systemLarge, !entry.tasks.isEmpty {
                    Divider().padding(.vertical, 2)
                    Text("Tasks").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(entry.tasks.prefix(3)) { task in
                        Link(destination: DeepLink.task(task.id).url) { TaskRow(task: task) }
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

struct RunningRow: View {
    let item: WatchItem

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title).font(.footnote.weight(.medium)).lineLimit(1)
                MonoPath(text: item.mono, weight: .regular, size: .caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            StatePill(state: item.state)
            Text(item.since, style: .relative)
                .font(.caption.monospacedDigit()).foregroundStyle(.tertiary).lineLimit(1)
                .frame(minWidth: 44, alignment: .trailing)
        }
    }
}

struct TaskRow: View {
    let task: InFlightTask

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(task.title).font(.footnote.weight(.medium)).lineLimit(1)
                HStack(spacing: 6) {
                    if !task.branch.isEmpty { MonoPath(text: task.branch, weight: .regular, size: .caption).foregroundStyle(.secondary) }
                    if let n = task.prNumber {
                        Text("#\(n)").font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                        if let ci = task.prChecksStatus, ci != "none" {
                            Text("CI \(ci)").font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                }
            }
            Spacer(minLength: 4)
            StatePill(state: task.state)
            if task.since > .distantPast {
                Text(task.since, style: .relative)
                    .font(.caption.monospacedDigit()).foregroundStyle(.tertiary).lineLimit(1)
                    .frame(minWidth: 44, alignment: .trailing)
            }
        }
    }
}

#Preview("Medium", as: .systemMedium) { InFlightWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.offline; GlanceFixtures.signedOut
}
#Preview("Large", as: .systemLarge) { InFlightWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.quiet; GlanceFixtures.stale; GlanceFixtures.offline; GlanceFixtures.signedOut
}
