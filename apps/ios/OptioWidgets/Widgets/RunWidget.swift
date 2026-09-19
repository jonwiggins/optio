import AppIntents
import SwiftUI
import WidgetKit

/// "Start": the phone as a remote control for one recurring session (a Task blueprint,
/// Job, or Local automation). One configurable target, one tap. Modest by design
/// (Tier 3): no status, no history, just the name and "Started · 2s ago" for one entry
/// after firing. Kind id kept from its "Run" days so placed widgets survive.
struct RunWidget: Widget {
    static let kind = WidgetKinds.run

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: Self.kind, intent: RunConfigurationIntent.self, provider: RunTimelineProvider()) { entry in
            RunView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Start")
        .description("Fire a recurring session — a Task blueprint, Job, or Local automation — with one tap.")
        .supportedFamilies([.systemSmall])
    }
}

struct RunEntry: TimelineEntry {
    let date: Date
    let target: RunTargetEntity?
    let confirm: Bool
    let signedIn: Bool
    let startedAt: Date?
    let armedAt: Date?

    var showsStarted: Bool { GlancePolicy.showsStarted(lastStartedAt: startedAt, now: date) }
    var isArmed: Bool { GlancePolicy.isArmed(armedAt: armedAt, now: date) }
}

struct RunTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> RunEntry {
        RunEntry(date: .now, target: RunFixtures.nightly, confirm: true, signedIn: true, startedAt: nil, armedAt: nil)
    }

    func snapshot(for configuration: RunConfigurationIntent, in context: Context) async -> RunEntry {
        entry(for: configuration, at: .now)
    }

    func timeline(for configuration: RunConfigurationIntent, in context: Context) async -> Timeline<RunEntry> {
        let now = Date.now
        let first = entry(for: configuration, at: now)
        var entries = [first]
        // Drop the "Started" / "Tap again" states on their own schedule, no reload needed.
        if let armed = first.armedAt, first.isArmed {
            entries.append(entry(for: configuration, at: armed.addingTimeInterval(GlancePolicy.armWindow)))
        }
        if let started = first.startedAt, first.showsStarted {
            entries.append(entry(for: configuration, at: started.addingTimeInterval(GlancePolicy.startedFlash)))
        }
        entries.sort { $0.date < $1.date }
        return Timeline(entries: entries, policy: .after(now.addingTimeInterval(60 * 60)))
    }

    private func entry(for configuration: RunConfigurationIntent, at date: Date) -> RunEntry {
        let target = configuration.target
        return RunEntry(date: date, target: target, confirm: configuration.confirm, signedIn: SharedCredentials.isConfigured,
                        startedAt: target.flatMap { GlanceStore.startedAt($0.id) }, armedAt: target.flatMap { GlanceStore.armedAt($0.id) })
    }
}

struct RunView: View {
    let entry: RunEntry

    var body: some View {
        if !entry.signedIn {
            SignedOutView()
        } else if let target = entry.target {
            Button(intent: RunTargetIntent(target: target, confirm: entry.confirm)) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Image(systemName: entry.showsStarted ? "checkmark.circle" : "play.circle")
                            .symbolRenderingMode(.hierarchical)
                            .font(.title3)
                            .foregroundStyle(entry.showsStarted ? .primary : .secondary)
                            .contentTransition(.symbolEffect(.replace))
                        Spacer()
                        VStack(alignment: .trailing, spacing: 1) {
                            Text(target.kind == .local ? "blueprint" : "job")
                            if let server = target.serverName ?? target.serverId.flatMap({ ServerRegistry.profile($0)?.shortName }), ServerRegistry.all.count > 1 {
                                HStack(spacing: 3) {
                                    if let c = target.serverId.flatMap({ ServerRegistry.profile($0)?.color }) {
                                        Circle().fill(c.swiftUI).frame(width: 5, height: 5)
                                    }
                                    Text(server).lineLimit(1)
                                }
                            }
                        }
                        .font(.caption2).foregroundStyle(.tertiary)
                    }
                    Spacer(minLength: 0)
                    Text(target.name)
                        .font(.headline)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .foregroundStyle(.primary)
                    if entry.showsStarted, let at = entry.startedAt {
                        HStack(spacing: 3) {
                            Text("Started ·").font(.footnote)
                            Text(at, style: .relative).font(.footnote.monospacedDigit())
                            Text("ago").font(.footnote)
                        }
                        .foregroundStyle(.secondary).lineLimit(1)
                    } else if entry.isArmed {
                        Text("Tap again to run").font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                    } else {
                        Text(entry.confirm ? "Tap twice to run" : "Tap to run").font(.footnote).foregroundStyle(.tertiary)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .buttonStyle(.plain)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Image(systemName: "play.circle").symbolRenderingMode(.hierarchical).font(.title3).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Text("Run").font(.headline).foregroundStyle(.secondary)
                Text("Choose a blueprint or Job to start.").font(.footnote).foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

enum RunFixtures {
    static let nightly = RunTargetEntity(id: "job:nightly", name: "Nightly digest", kind: .job)
    static let deploy = RunTargetEntity(id: "local:deploy", name: "Deploy preview", kind: .local, spawnMode: "auto")
    static let idle = RunEntry(date: .now, target: nightly, confirm: true, signedIn: true, startedAt: nil, armedAt: nil)
    static let armed = RunEntry(date: .now, target: deploy, confirm: true, signedIn: true, startedAt: nil, armedAt: .now)
    static let started = RunEntry(date: .now, target: deploy, confirm: false, signedIn: true, startedAt: .now.addingTimeInterval(-2), armedAt: nil)
    static let unconfigured = RunEntry(date: .now, target: nil, confirm: true, signedIn: true, startedAt: nil, armedAt: nil)
    static let signedOut = RunEntry(date: .now, target: nightly, confirm: true, signedIn: false, startedAt: nil, armedAt: nil)
}

#Preview("Run", as: .systemSmall) { RunWidget() } timeline: {
    RunFixtures.idle; RunFixtures.armed; RunFixtures.started; RunFixtures.unconfigured; RunFixtures.signedOut
}
