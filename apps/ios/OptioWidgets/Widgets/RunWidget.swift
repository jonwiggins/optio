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

    private var tint: Color { entry.showsStarted ? StatusColor.green : (entry.isArmed ? StatusColor.yellow : StatusColor.purple) }

    var body: some View {
        Group {
            if !entry.signedIn {
                SignedOutView()
            } else if let target = entry.target {
                Button(intent: RunTargetIntent(target: target, confirm: entry.confirm)) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .top) {
                            Image(systemName: entry.showsStarted ? "checkmark" : (entry.isArmed ? "arrow.right" : "play.fill"))
                                .font(.body.weight(.semibold))
                                .foregroundStyle(tint)
                                .frame(width: 36, height: 36)
                                .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .widgetAccentable()
                                .contentTransition(.symbolEffect(.replace))
                            Spacer(minLength: 4)
                            VStack(alignment: .trailing, spacing: 3) {
                                Text(target.kind == .local ? "Automation" : "Job")
                                if let server = target.serverName ?? target.serverId.flatMap({ ServerRegistry.profile($0)?.shortName }), ServerRegistry.all.count > 1 {
                                    Text(server).lineLimit(1)
                                }
                            }
                            .font(.caption2).foregroundStyle(Color.secondary)
                        }
                        Spacer(minLength: 0)
                        Text(target.name)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .foregroundStyle(Color.primary)
                        Group {
                            if entry.showsStarted, let started = entry.startedAt {
                                Text("Started · \(Text(started, style: .relative)) ago")
                            } else {
                                Text(entry.isArmed ? "Tap again to confirm" : (entry.confirm ? "Tap twice to start" : "Tap to start"))
                            }
                        }
                            .font(.caption.weight(.medium))
                            .foregroundStyle(entry.showsStarted || entry.isArmed ? tint : Color.secondary)
                            .lineLimit(2)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .contentShape(ContainerRelativeShape())
                }
                .buttonStyle(.plain)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "play.circle").font(.title2).foregroundStyle(StatusColor.purple)
                    Spacer(minLength: 0)
                    Text("Start work").font(.headline)
                    Text("Edit this widget to choose an automation or Job.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .glanceTypeClamp()
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
