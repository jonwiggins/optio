import ActivityKit
import SwiftUI
import WidgetKit

/// The one Optio Live Activity: "the session waiting on you, plus how many more".
/// Region table and copy: docs/design/ios-glanceable-surfaces.md §2a.
///
/// The head session renders as a session row — status dot · name · `status · reason`,
/// then its four attribute chips (When / Where / Who / Then, the same icons as the
/// app's `SessionRowView`) — with the "since" timer and a counts line underneath.
/// Colour follows the status palette (Shared/StatusColor.swift): yellow while a
/// session needs you, purple while sessions are working, grey when offline / ended.
/// The only live elements are the system timers.
struct WatchLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: WatchAttributes.self) { context in
            WatchLockScreenView(state: context.state)
                .widgetURL(WatchCopy.url(for: context.state))
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    WatchExpandedLeading(state: state)
                }
                DynamicIslandExpandedRegion(.center) {
                    WatchExpandedCenter(state: state)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    WatchExpandedTrailing(state: state)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        if let head = state.head, state.phase == .waiting || state.phase == .working {
                            SessionChips(item: head, short: true, grid: true, font: .caption2, spacing: 14)
                                .padding(.leading, 4)
                        }
                        WatchCountsLine(state: state)
                        WatchButtons(state: state)
                    }
                }
            } compactLeading: {
                WatchCompactLeading(state: state)
            } compactTrailing: {
                WatchCompactTrailing(state: state)
            } minimal: {
                WatchMinimal(state: state)
            }
            .widgetURL(WatchCopy.url(for: state))
            .keylineTint(WatchCopy.tint(state.phase))
        }
    }
}

// MARK: - Copy & styling

enum WatchCopy {
    /// #6d28d9 — the action colour for the prominent button.
    static let purple = StatusColor.purple

    /// Phase → status colour: yellow needs input, purple working, grey otherwise.
    static func tint(_ phase: WatchState.Phase) -> Color {
        switch phase {
        case .waiting: return StatusColor.yellow
        case .working: return StatusColor.purple
        case .offline, .done: return StatusColor.grey
        }
    }

    /// Headline / timer style for a phase.
    static func style(_ phase: WatchState.Phase) -> AnyShapeStyle {
        switch phase {
        case .waiting, .working: return AnyShapeStyle(tint(phase))
        case .offline, .done: return AnyShapeStyle(.secondary)
        }
    }

    /// "2 sessions need you" / "Nothing needs you · 3 running" / "Machine unreachable" / "Sessions ended".
    static func headline(_ state: WatchState) -> String {
        GlanceCopy.headline(phase: state.phase.rawValue, needsYou: state.needsYouCount, running: state.runningCount)
    }

    /// Short headline for the narrow leading region: "Needs you" / "Running" / "Offline" / "Ended".
    static func shortHeadline(_ state: WatchState) -> String {
        switch state.phase {
        case .waiting: return "Needs you"
        case .working: return "Running"
        case .offline: return "Offline"
        case .done: return "Ended"
        }
    }

    static func offlineLine(_ state: WatchState) -> String {
        let t = (state.offlineSince ?? state.asOf).formatted(date: .omitted, time: .shortened)
        return "Machine unreachable since \(t)"
    }

    static func workingLine(_ state: WatchState) -> String {
        GlanceCopy.workingLine(running: state.runningCount)
    }

    /// `status · reason` under the name: "needs you · Waiting on a permission",
    /// "needs attention · Merge conflict". A reason that already opens with the status
    /// word ("PR #581 open · CI running" under "PR open") stands alone.
    static func statusLine(_ item: WatchItem) -> String {
        let status = item.statusText
        guard let reason = item.reason, !reason.isEmpty else { return status }
        let first = { (s: String) in s.lowercased().split(separator: " ").first.map(String.init) ?? "" }
        if reason.lowercased() == status.lowercased() || first(reason) == first(status) { return reason }
        return "\(status) · \(reason)"
    }

    /// The counts line under the head: "2 more need you · 3 running" (waiting) or
    /// "3 sessions running" (working). Empty when it would repeat the headline.
    static func countsLine(_ state: WatchState) -> String {
        switch state.phase {
        case .waiting: return GlanceCopy.countsLine(needsYou: state.needsYouCount, running: state.runningCount, excludingHead: true)
        case .working: return state.runningCount > 1 ? "\(state.runningCount - 1) more running" : ""
        case .offline, .done: return ""
        }
    }

    static func summaryLine(_ state: WatchState) -> String {
        state.summary ?? "Sessions ended."
    }

    static func url(for state: WatchState) -> URL? {
        if let link = state.head?.link, let url = URL(string: link) { return url }
        return DeepLink.needsYou.url
    }

    static func isFailedTask(_ item: WatchItem) -> Bool { item.kind == .task && item.state == "failed" }
    static func isAttentionTask(_ item: WatchItem) -> Bool { item.kind == .task && item.state == "needs_attention" }
    static func prURL(_ item: WatchItem) -> URL? {
        guard item.kind == .task, item.state == "pr_opened" || item.prUrl != nil, let s = item.prUrl else { return nil }
        return URL(string: s)
    }
}

/// "● MacBook" after the name when more than one server is paired, so the island
/// says which laptop is asking. Nothing with a single server.
struct WatchServerTag: View {
    let item: WatchItem
    var size: Font = .caption2

    private var profile: ServerProfile? {
        guard ServerRegistry.all.count > 1, let id = item.serverId else { return nil }
        return ServerRegistry.profile(id)
    }

    var body: some View {
        if let p = profile {
            HStack(spacing: 3) {
                Circle().fill(p.color.swiftUI).frame(width: 6, height: 6)
                Text(p.shortName).font(size.weight(.medium)).foregroundStyle(.secondary).lineLimit(1)
            }
            .accessibilityLabel("on \(p.name)")
        }
    }
}

/// Monospace path/branch/slug, truncating head-first so the leaf survives.
struct MonoText: View {
    let text: String
    var size: Font.TextStyle = .subheadline
    var weight: Font.Weight = .semibold

    var body: some View {
        Text(text)
            .font(.system(size, design: .monospaced).weight(weight))
            .lineLimit(1)
            .truncationMode(.head)
    }
}

/// The Optio bot in the phase colour (lock-screen header mark).
struct WatchGlyph: View {
    let phase: WatchState.Phase
    var size: CGFloat = 20

    var body: some View {
        OptioGlyph(size: size, style: WatchCopy.tint(phase))
            .widgetAccentable(phase == .waiting)
    }
}

/// A status dot for one session: yellow needs input, purple working, red failed, green done.
struct WatchStateDot: View {
    let item: WatchItem
    var size: CGFloat = 7

    var body: some View {
        Circle()
            .fill(StatusKind.forState(item.state).color)
            .frame(width: size, height: size)
            .accessibilityLabel(StatusKind.forState(item.state).label)
    }
}

/// The phase dot (no item): the island's compact / minimal mark.
struct WatchPhaseDot: View {
    let phase: WatchState.Phase
    var size: CGFloat = 8

    var body: some View {
        Circle().fill(WatchCopy.tint(phase)).frame(width: size, height: size)
            .widgetAccentable(phase == .waiting)
    }
}

/// The head session as a row: `● name [server]` then `status · reason`. Shared by
/// the expanded island centre and the lock screen.
struct WatchHeadRow: View {
    let item: WatchItem
    var nameFont: Font = .subheadline.weight(.semibold)
    var lineFont: Font = .caption
    var dotSize: CGFloat = 7
    /// Show the last output line instead of `status · reason` when there is one.
    var preview = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                WatchStateDot(item: item, size: dotSize)
                Text(item.title).font(nameFont).lineLimit(1)
                WatchServerTag(item: item)
            }
            if preview, let line = item.preview, !line.isEmpty {
                Text(line).font(lineFont).foregroundStyle(.secondary).lineLimit(1).privacySensitive()
            } else {
                Text(WatchCopy.statusLine(item)).font(lineFont).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }
}

/// "2 more need you · 3 running" in the phase colour; nothing when empty.
struct WatchCountsLine: View {
    let state: WatchState

    var body: some View {
        let line = WatchCopy.countsLine(state)
        if !line.isEmpty {
            Text(line)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .padding(.leading, 4)
                .contentTransition(.numericText())
        }
    }
}

// MARK: - Dynamic Island regions

/// Status dot + the number that matters: needs-you while waiting, running otherwise.
struct WatchCompactLeading: View {
    let state: WatchState

    var body: some View {
        HStack(spacing: 4) {
            WatchPhaseDot(phase: state.phase, size: 8)
            switch state.phase {
            case .waiting:
                Text("\(state.needsYouCount)")
                    .font(.caption.weight(.bold).monospacedDigit())
                    .foregroundStyle(StatusColor.yellow)
                    .contentTransition(.numericText())
                    .widgetAccentable()
            case .working:
                Text("\(state.runningCount)")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(state.runningCount > 0 ? AnyShapeStyle(StatusColor.purple) : AnyShapeStyle(.secondary))
                    .contentTransition(.numericText())
            case .offline, .done:
                EmptyView()
            }
        }
        .padding(.leading, 2)
    }
}

/// The head's Who glyph (terminal vs agent) with the head's name; offline / ended words otherwise.
struct WatchCompactTrailing: View {
    let state: WatchState

    var body: some View {
        switch state.phase {
        case .waiting, .working:
            if let head = state.head {
                HStack(spacing: 4) {
                    WhoGlyph(item: head, size: 11, style: AnyShapeStyle(WatchCopy.tint(state.phase)))
                    Text(head.rowName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(WatchCopy.tint(state.phase))
                        .lineLimit(1)
                        .frame(maxWidth: 56, alignment: .trailing)
                }
                .widgetAccentable(state.phase == .waiting)
            } else {
                Text(WatchCopy.workingLine(state)).font(.caption).foregroundStyle(.secondary)
            }
        case .offline:
            Text("offline").font(.caption).foregroundStyle(.secondary)
        case .done:
            Text("ended").font(.caption).foregroundStyle(.tertiary)
        }
    }
}

/// The status dot with the count inside: yellow while waiting, purple while running.
struct WatchMinimal: View {
    let state: WatchState

    var body: some View {
        switch state.phase {
        case .waiting:
            ZStack {
                Circle().fill(StatusColor.yellow)
                Text("\(state.needsYouCount)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.black)
                    .contentTransition(.numericText())
            }
            .frame(width: 20, height: 20)
            .widgetAccentable()
        case .working where state.runningCount > 0:
            ZStack {
                Circle().fill(StatusColor.purple)
                Text("\(state.runningCount)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
                    .contentTransition(.numericText())
            }
            .frame(width: 20, height: 20)
        default:
            WatchPhaseDot(phase: state.phase, size: 10)
        }
    }
}

struct WatchExpandedLeading: View {
    let state: WatchState

    var body: some View {
        HStack(spacing: 6) {
            WatchPhaseDot(phase: state.phase, size: 8)
            Text(WatchCopy.shortHeadline(state))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(WatchCopy.style(state.phase))
        }
        .padding(.leading, 4)
    }
}

struct WatchExpandedCenter: View {
    let state: WatchState

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            switch state.phase {
            case .waiting, .working:
                if let head = state.head {
                    WatchHeadRow(item: head, preview: state.phase == .waiting)
                } else {
                    Text("No sessions running").font(.subheadline).foregroundStyle(.secondary)
                }
            case .offline:
                Text(WatchCopy.offlineLine(state)).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            case .done:
                Text(WatchCopy.summaryLine(state)).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The "since" timer: how long the head has been waiting (yellow) or running (secondary).
struct WatchExpandedTrailing: View {
    let state: WatchState

    var body: some View {
        switch state.phase {
        case .waiting:
            if let head = state.head {
                Text(head.since, style: .timer)
                    .font(.subheadline.monospacedDigit().weight(.semibold))
                    .foregroundStyle(StatusColor.yellow)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 52, alignment: .trailing)
                    .widgetAccentable()
            }
        case .working:
            if let head = state.head {
                Text(timerInterval: head.since...head.since.addingTimeInterval(8 * 3600), countsDown: false)
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 52, alignment: .trailing)
            }
        case .offline, .done:
            EmptyView()
        }
    }
}

/// Bottom row. Waiting: **Reply…** + **Later**. Followed task in `pr_opened`: **Open PR**.
/// `needs_attention` task: **Resume**; `failed` task: **Retry**. Working: nothing (no filler).
struct WatchButtons: View {
    let state: WatchState

    var body: some View {
        if let head = state.head {
            HStack(spacing: 8) {
                if state.phase == .waiting {
                    if WatchCopy.isAttentionTask(head) {
                        Button(intent: ResumeTaskIntent(taskId: head.id, serverId: head.serverId)) { pill("Resume", prominent: true) }
                            .buttonStyle(.plain)
                    } else if WatchCopy.isFailedTask(head) {
                        Button(intent: RetryTaskIntent(taskId: head.id, serverId: head.serverId)) { pill("Retry", prominent: true) }
                            .buttonStyle(.plain)
                    }
                    if let url = URL(string: head.link) {
                        Link(destination: url) { pill(head.thenValue == .waitsForMessages ? "Message…" : "Reply…", prominent: !WatchCopy.isAttentionTask(head) && !WatchCopy.isFailedTask(head)) }
                    }
                    if let pr = WatchCopy.prURL(head) {
                        Link(destination: pr) { pill("Open PR", prominent: false) }
                    }
                    Button(intent: LaterIntent(item: head)) { pill("Later", prominent: false) }
                        .buttonStyle(.plain)
                } else if state.phase == .working, let pr = WatchCopy.prURL(head) {
                    Link(destination: pr) { pill("Open PR", prominent: false) }
                }
            }
            .padding(.top, 2)
        }
    }

    private func pill(_ title: String, prominent: Bool) -> some View {
        Text(title)
            .font(.footnote.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 7)
            .background(prominent ? AnyShapeStyle(WatchCopy.purple) : AnyShapeStyle(.fill.tertiary), in: Capsule())
            .foregroundStyle(prominent ? .white : .primary)
    }
}

// MARK: - Lock screen / StandBy

/// Headline row, the head session as a session row (name, `status · reason`, four
/// chips), the counts line, then the buttons. StandBy (`isActivityFullscreen`) gets
/// larger type and drops the chips and buttons.
struct WatchLockScreenView: View {
    let state: WatchState
    @Environment(\.isActivityFullscreen) private var fullscreen

    var body: some View {
        VStack(alignment: .leading, spacing: fullscreen ? 10 : 6) {
            HStack(spacing: 6) {
                WatchGlyph(phase: state.phase, size: fullscreen ? 28 : 20)
                Text(WatchCopy.headline(state))
                    .font((fullscreen ? Font.title3 : .subheadline).weight(.semibold))
                    .foregroundStyle(WatchCopy.style(state.phase))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 8)
                trailing
            }
            center
            if !fullscreen {
                WatchButtons(state: state)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    @ViewBuilder private var trailing: some View {
        switch state.phase {
        case .waiting:
            if let head = state.head {
                Text(head.since, style: .timer)
                    .font((fullscreen ? Font.title3 : .subheadline).monospacedDigit().weight(.semibold))
                    .foregroundStyle(StatusColor.yellow)
                    .frame(minWidth: 44, alignment: .trailing)
                    .widgetAccentable()
            }
        case .working:
            if let head = state.head {
                Text(timerInterval: head.since...head.since.addingTimeInterval(8 * 3600), countsDown: false)
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 44, alignment: .trailing)
            }
        case .offline, .done:
            EmptyView()
        }
    }

    @ViewBuilder private var center: some View {
        switch state.phase {
        case .waiting, .working:
            if let head = state.head {
                VStack(alignment: .leading, spacing: fullscreen ? 6 : 4) {
                    WatchHeadRow(item: head,
                                 nameFont: (fullscreen ? Font.title3 : .body).weight(.semibold),
                                 lineFont: fullscreen ? .body : .footnote,
                                 dotSize: fullscreen ? 9 : 7,
                                 preview: false)
                    if !fullscreen {
                        SessionChips(item: head, short: false, grid: true, font: .caption2, spacing: 14).padding(.leading, 13)
                    }
                    let counts = WatchCopy.countsLine(state)
                    if !counts.isEmpty {
                        Text(counts)
                            .font(fullscreen ? .body : .caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                            .padding(.leading, fullscreen ? 0 : 13)
                            .contentTransition(.numericText())
                    }
                }
            } else {
                Text("No sessions running").font(.subheadline).foregroundStyle(.secondary)
            }
        case .offline:
            Text(WatchCopy.offlineLine(state)).font(fullscreen ? .title3 : .subheadline).foregroundStyle(.secondary)
        case .done:
            Text(WatchCopy.summaryLine(state)).font(fullscreen ? .title3 : .subheadline).foregroundStyle(.secondary)
        }
    }
}

// MARK: - Fixtures & previews

extension WatchState {
    enum Samples {
        static let head = WatchItem(
            kind: .local, id: "t1", title: "claude-code · web", mono: "optio/apps/web",
            reason: "Waiting on a permission", preview: "Allow Bash(pnpm test)? (y/n)",
            since: Date().addingTimeInterval(-4 * 60), state: "needs_you",
            link: DeepLink.local("t1", compose: true).url.absoluteString,
            source: .localTerminal, when: "now", where: WatchWhere(target: .machine, detail: "MacBook Pro · ~/repos/optio/apps/web"),
            who: "claude-code", then: .waitsForMe, statusLabel: "needs you")
        static let second = WatchItem(
            kind: .local, id: "t2", title: "claude-code · api", mono: "optio/apps/api",
            reason: "Claude stopped — reply to continue", since: Date().addingTimeInterval(-90), state: "needs_you",
            link: DeepLink.local("t2", compose: true).url.absoluteString,
            source: .localTerminal, when: "github", where: WatchWhere(target: .machine, detail: "MacBook Pro · ~/repos/optio/apps/api"),
            who: "claude-code", then: .waitsForMe, statusLabel: "needs you")
        static let task = WatchItem(
            kind: .task, id: "task1", title: "Fix login redirect loop", mono: "fix/login-redirect",
            reason: "PR #581 open · CI running", since: Date().addingTimeInterval(-12 * 60), state: "pr_opened",
            link: DeepLink.task("task1").url.absoluteString, prUrl: "https://github.com/jonwiggins/optio/pull/581",
            source: .repoTask, when: "now", where: WatchWhere(target: .pod, detail: "jonwiggins/optio"),
            who: "claude-code", then: .exits, statusLabel: "PR open")
        static let attentionTask = WatchItem(
            kind: .task, id: "task2", title: "Migrate settings to Drizzle", mono: "feat/settings-drizzle",
            reason: "Merge conflict — resume?", since: Date().addingTimeInterval(-7 * 60), state: "needs_attention",
            link: DeepLink.task("task2").url.absoluteString, prUrl: "https://github.com/jonwiggins/optio/pull/590",
            source: .repoTask, when: "on a trigger", where: WatchWhere(target: .pod, detail: "jonwiggins/optio"),
            who: "codex", then: .exits, statusLabel: "needs attention")
        static let agent = WatchItem(
            kind: .agent, id: "a1", title: "Vesper", mono: "@vesper",
            reason: nil, since: Date().addingTimeInterval(-3 * 60), state: "running",
            link: DeepLink.agent("a1", compose: true).url.absoluteString,
            source: .persistentAgent, when: "messages", where: WatchWhere(target: .pod, detail: "@vesper"),
            who: "claude-code", then: .waitsForMessages, statusLabel: "running")
        /// A row from a server that predates the session chips: every fallback kicks in.
        static let legacy = WatchItem(
            kind: .local, id: "t3", title: "codex · cli", mono: "optio/apps/cli",
            reason: "Gone quiet — check in", since: Date().addingTimeInterval(-20 * 60), state: "needs_you",
            link: DeepLink.local("t3", compose: true).url.absoluteString)

        static let waiting = WatchState(phase: .waiting, head: head, others: [second], needsYouCount: 3, runningCount: 2, waitingCount: 1, recurringCount: 4, agentCount: 2)
        static let waitingTask = WatchState(phase: .waiting, head: attentionTask, needsYouCount: 1, runningCount: 1)
        static let waitingLegacy = WatchState(phase: .waiting, head: legacy, needsYouCount: 1, runningCount: 0)
        static let working = WatchState(phase: .working, head: task, needsYouCount: 0, runningCount: 3, waitingCount: 1, recurringCount: 4, agentCount: 2)
        static let workingAgent = WatchState(phase: .working, head: agent, needsYouCount: 0, runningCount: 1)
        static let offline = WatchState(phase: .offline, needsYouCount: 0, runningCount: 0, offlineSince: Date().addingTimeInterval(-6 * 60))
        static let done = WatchState(phase: .done, summary: "Sessions ended. 3 answered, 1 PR merged.")
    }
}

#Preview("Waiting", as: .content, using: WatchAttributes(userId: "preview")) {
    WatchLiveActivity()
} contentStates: {
    WatchState.Samples.waiting
    WatchState.Samples.waitingTask
    WatchState.Samples.waitingLegacy
}

#Preview("Working", as: .content, using: WatchAttributes(userId: "preview")) {
    WatchLiveActivity()
} contentStates: {
    WatchState.Samples.working
    WatchState.Samples.workingAgent
}

#Preview("Offline · Done", as: .content, using: WatchAttributes(userId: "preview")) {
    WatchLiveActivity()
} contentStates: {
    WatchState.Samples.offline
    WatchState.Samples.done
}

#Preview("Island expanded", as: .dynamicIsland(.expanded), using: WatchAttributes(userId: "preview")) {
    WatchLiveActivity()
} contentStates: {
    WatchState.Samples.waiting
    WatchState.Samples.working
    WatchState.Samples.offline
    WatchState.Samples.done
}

#Preview("Island compact", as: .dynamicIsland(.compact), using: WatchAttributes(userId: "preview")) {
    WatchLiveActivity()
} contentStates: {
    WatchState.Samples.waiting
    WatchState.Samples.working
}

#Preview("Island minimal", as: .dynamicIsland(.minimal), using: WatchAttributes(userId: "preview")) {
    WatchLiveActivity()
} contentStates: {
    WatchState.Samples.waiting
    WatchState.Samples.working
}
