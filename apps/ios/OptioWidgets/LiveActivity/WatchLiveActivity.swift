import ActivityKit
import SwiftUI
import WidgetKit

/// The one Optio Live Activity: a phase headline and running count above the
/// sessions waiting on you. It shares metrics, status words and row styling with
/// the Work widget, whose larger board also carries Waiting / Recurring / Agents.
///
/// - Two or more sessions need you: they are listed as the widget's rows
///   (`● name  ✋ Allow?  14:32  ☾`), oldest first: all of them up to three, else the
///   oldest two and "+N more" (`WatchState.listed`). A row opens its session; the moon
///   is **Later**.
/// - One needs you: it is shown in detail (name, status word and reason, how long it has
///   waited) with its buttons: **Reply…** / **Later**, **Resume** / **Retry** for a task.
/// - Nothing needs you: the running sessions, listed the same way, newest first (without
///   the moon); a lone one in detail, with **Open PR** for a task at an open PR.
///
/// The island keeps the two numbers that matter: needs-you on the leading side, running
/// on the trailing side, and the same list or detail underneath when expanded.
///
/// Standard values (counts, status words, timers) always render whole; only free text
/// (a session's name, the reason, the preview) may end in an ellipsis. The lock screen
/// clips a Live Activity past 160 pt, so the layout is sized for that at the largest text
/// size it allows (`glanceTypeClamp`); WidgetSnapshots renders it at phone widths and
/// text sizes.
@available(iOS 18.0, *)
struct WatchLiveActivity: Widget {
    var body: some WidgetConfiguration {
        LegacyWatchLiveActivity().body.supplementalActivityFamilies([.small, .medium])
    }
}

/// Keep the iOS 17 configuration; the supplemental family API starts at iOS 18.
struct LegacyWatchLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: WatchAttributes.self) { context in
            Group {
                if #available(iOS 18.0, *) {
                    AdaptiveWatchActivity(state: context.state, isStale: context.isStale)
                } else {
                    WatchLockScreenView(state: context.state, isStale: context.isStale)
                }
            }
            .widgetURL(WatchCopy.url(for: context.state))
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    WatchExpandedLeading(state: state)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    WatchExpandedTrailing(state: state)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    WatchExpandedBottom(state: state)
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
    static func symbol(_ phase: WatchState.Phase) -> String {
        switch phase {
        case .waiting: return "exclamationmark.bubble.fill"
        case .working: return "circle.dotted"
        case .offline: return "wifi.slash"
        case .done: return "checkmark.circle.fill"
        }
    }

    static func title(_ state: WatchState) -> String {
        switch state.phase {
        case .waiting: return "\(state.needsYouCount) need\(state.needsYouCount == 1 ? "s" : "") you"
        case .working: return state.runningCount > 0 ? "\(state.runningCount) running" : "All clear"
        case .offline: return "Connection lost"
        case .done: return "Work complete"
        }
    }

    /// #6d28d9 — the action colour for the prominent button.
    static let purple = StatusColor.purple

    /// Phase → status colour: green needs input, purple working, yellow offline, grey done.
    static func tint(_ phase: WatchState.Phase) -> Color {
        switch phase {
        case .waiting: return StatusColor.green
        case .working: return StatusColor.purple
        case .offline: return StatusColor.yellow
        case .done: return StatusColor.grey
        }
    }

    /// Headline / timer style for a phase.
    static func style(_ phase: WatchState.Phase) -> AnyShapeStyle {
        switch phase {
        case .waiting, .working: return AnyShapeStyle(tint(phase))
        case .offline, .done: return AnyShapeStyle(.secondary)
        }
    }

    /// The Work widget's tiles for this frame: Need you and Running always, Waiting /
    /// Recurring / Agents when the server sent them.
    static func tiles(_ state: WatchState) -> [GlanceCopy.Tile] {
        GlanceCopy.tiles(needsYou: state.needsYouCount, running: state.runningCount,
                         waiting: state.waitingCount, recurring: state.recurringCount, agents: state.agentCount)
    }

    /// The headline, longest first; the view shows the first that fits whole.
    static func headlineOptions(_ state: WatchState) -> [String] {
        GlanceCopy.headlineOptions(phase: state.phase.rawValue, needsYou: state.needsYouCount, running: state.runningCount)
    }

    static func offlineLine(_ state: WatchState) -> String {
        let t = (state.offlineSince ?? state.asOf).formatted(date: .omitted, time: .shortened)
        return "Machine unreachable since \(t)"
    }

    /// The line under the name, as a status word that always renders whole and a
    /// detail that may shorten: ("needs you", "Waiting on a permission"), ("needs
    /// attention", "Merge conflict — resume?"), ("later", …) after **Later**. `preview`
    /// prefers the last output line to the reason. A detail that already opens with
    /// the status word ("PR #581 open · CI running" under "PR open") stands alone.
    static func statusParts(_ item: WatchItem, preview: Bool = false, now: Date = .now) -> (word: String?, detail: String?) {
        let status = item.watchStatusText(at: now)
        let text = (preview ? item.preview.flatMap { $0.isEmpty ? nil : $0 } : nil) ?? item.reason
        guard let text, !text.isEmpty else { return (status, nil) }
        let first = { (s: String) in s.lowercased().split(separator: " ").first.map(String.init) ?? "" }
        if text.lowercased() == status.lowercased() || first(text) == first(status) { return (nil, text) }
        return (status, text)
    }

    /// `status · detail` in one string (accessibility, tests).
    static func statusLine(_ item: WatchItem, preview: Bool = false, now: Date = .now) -> String {
        let parts = statusParts(item, preview: preview, now: now)
        return [parts.word, parts.detail].compactMap { $0 }.joined(separator: " · ")
    }

    /// The status word's colour: the item's status, grey while put off with **Later**.
    static func statusColor(_ item: WatchItem, now: Date = .now) -> Color {
        item.isSnoozed(at: now) ? StatusColor.grey : StatusKind.forState(item.state).color
    }

    /// The button that opens the session: "Reply…" for a terminal, "Message…" for a
    /// persistent agent, "Open" for a task (a task takes no reply).
    static func openLabel(_ item: WatchItem) -> String {
        if item.thenValue == .waitsForMessages { return "Message…" }
        return item.kind == .task ? "Open" : "Reply…"
    }

    /// "+10 more": the sessions the list leaves out (needing you, else running).
    static func moreLine(_ state: WatchState) -> String? {
        state.unlisted > 0 ? "+\(state.unlisted) more" : nil
    }

    /// The final frame's line under "Sessions ended": the summary without the words the
    /// headline already says ("3 answered, 1 PR merged."). Nil when nothing is left.
    static func summaryLine(_ state: WatchState) -> String? {
        let summary = (state.summary ?? "").trimmingCharacters(in: .whitespaces)
        let headline = "Sessions ended."
        let rest = summary.hasPrefix(headline) ? String(summary.dropFirst(headline.count)).trimmingCharacters(in: .whitespaces) : summary
        return rest.isEmpty ? nil : rest
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

    /// More than one server is paired, so rows say which one they are on.
    static var showsServers: Bool { ServerRegistry.all.count > 1 }

    private var profile: ServerProfile? {
        guard Self.showsServers, let id = item.serverId else { return nil }
        return ServerRegistry.profile(id)
    }

    var body: some View {
        if let p = profile {
            HStack(spacing: 3) {
                Circle().fill(p.color.swiftUI).frame(width: 6, height: 6)
                Text(p.shortName).font(size.weight(.medium)).foregroundStyle(.secondary).lineLimit(1)
            }
            .fixedSize()
            .accessibilityLabel("on \(p.name)")
        }
    }
}

/// The Optio bot in the phase colour (lock-screen header mark).
struct WatchGlyph: View {
    let phase: WatchState.Phase
    var size: CGFloat = 20

    var body: some View {
        Image(systemName: WatchCopy.symbol(phase))
            .font(.system(size: size, weight: .medium))
            .foregroundStyle(WatchCopy.tint(phase))
            .widgetAccentable(phase == .waiting)
            .accessibilityHidden(true)
    }
}

/// A status dot for one session: yellow needs input, purple working, red failed, green
/// done, grey while a **Later** window is open.
struct WatchStateDot: View {
    let item: WatchItem
    var size: CGFloat = 7

    var body: some View {
        let snoozed = item.isSnoozed()
        let kind = snoozed ? StatusKind.dead : StatusKind.forState(item.state)
        Circle()
            .fill(kind.color)
            .frame(width: size, height: size)
            .accessibilityLabel(snoozed ? "later" : kind.label)
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

/// The headline, as long as the width allows ("Sessions ended", else "Ended"). Never
/// an ellipsis.
struct WatchHeadline: View {
    let state: WatchState
    var font: Font = .subheadline.weight(.semibold)

    var body: some View {
        ViewThatFits(in: .horizontal) {
            ForEach(WatchCopy.headlineOptions(state), id: \.self) { line in
                Text(line).lineLimit(1).fixedSize()
            }
        }
        .font(font)
        .foregroundStyle(WatchCopy.style(state.phase))
    }
}

/// How long the head has been waiting (yellow) or running (secondary), sized to its
/// widest value so hours never wrap it.
struct WatchSinceTimer: View {
    let state: WatchState
    var font: Font = .subheadline

    var body: some View {
        switch state.phase {
        case .waiting:
            if let head = state.head {
                FitTimer(since: head.since, font: font.weight(.semibold), style: AnyShapeStyle(StatusColor.green))
                    .widgetAccentable()
            }
        case .working:
            if let head = state.head {
                FitTimer(since: head.since, countUp: true, font: font, style: AnyShapeStyle(.secondary))
            }
        case .offline, .done:
            EmptyView()
        }
    }
}

/// `needs you  Waiting on a permission`: the status word whole and coloured, then the
/// reason (or the last output line) in whatever room is left.
struct WatchStatusLine: View {
    let item: WatchItem
    var preview = false
    var font: Font = .footnote

    var body: some View {
        let parts = WatchCopy.statusParts(item, preview: preview)
        HStack(spacing: 5) {
            if let word = parts.word {
                Text(word)
                    .font(font.weight(.semibold))
                    .foregroundStyle(WatchCopy.statusColor(item))
                    .lineLimit(1)
                    .fixedSize()
            }
            if let detail = parts.detail {
                Text(detail)
                    .font(font)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .privacySensitive(preview && item.preview != nil)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A board number over its noun, `3` / `need you`: the island's two expanded sides.
/// Grey at zero, like the tiles.
struct WatchCount: View {
    let count: Int
    let noun: String
    let color: Color
    var alignment: HorizontalAlignment = .leading

    var body: some View {
        GlanceMetric(count: count, label: noun, color: color, compact: true, alignment: alignment)
    }
}

// MARK: - Sessions

/// One session as the Work widget's row with a live clock: `● name [server]  ✋ Allow?
/// 14:32  ☾` for one waiting on you, `● name  working  3:10` for one running. The row
/// opens the session (its composer for a terminal or an agent); the moon is **Later**.
/// Only the name may shorten.
struct WatchListRow: View {
    let item: WatchItem
    var large = false
    var showsLater = true

    var body: some View {
        HStack(spacing: 8) {
            Link(destination: URL(string: item.link) ?? DeepLink.needsYou.url) {
                HStack(spacing: 6) {
                    WhoGlyph(item: item, size: large ? 17 : 13, colored: true).accessibilityHidden(true)
                    Text(item.rowName)
                        .font((large ? Font.body : .footnote).weight(.semibold))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if WatchServerTag.showsServers, let tag = ServerTag(item: item) { tag.dot() }
                    Spacer(minLength: 4)
                    WatchRowStatus(item: item, font: (large ? Font.subheadline : .caption).weight(.semibold))
                        .layoutPriority(1)
                    // Concrete colours inside a Link: the hierarchical `.secondary` would
                    // take the link tint.
                    FitTimer(since: item.since, font: large ? .subheadline : .caption, style: AnyShapeStyle(Color.secondary))
                        .layoutPriority(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }
            if showsLater {
                Button(intent: LaterIntent(item: item)) {
                    Image(systemName: "moon.zzz")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 28)
                        .background(.fill.tertiary, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Later: \(item.rowName)")
            }
        }
    }
}

/// A row's status in the widget's vocabulary (`✋ Allow?`, `PR`, `working`), or `☾ Later`
/// in grey while a **Later** window is open: the session counts as running until then.
struct WatchRowStatus: View {
    let item: WatchItem
    var font: Font = .caption.weight(.semibold)

    var body: some View {
        if item.isSnoozed() {
            HStack(spacing: 3) {
                Image(systemName: "moon.zzz")
                Text("Later")
            }
            .font(font)
            .foregroundStyle(StatusColor.grey)
            .lineLimit(1)
            .fixedSize()
        } else {
            StatusBadge(item: item, font: font)
        }
    }
}

/// One session in detail: `● name [server] … 14:32`, then the status word and the
/// reason (or, while it waits on you, the last output line).
struct WatchDetailRow: View {
    let state: WatchState
    let item: WatchItem
    var large = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                WhoGlyph(item: item, size: large ? 22 : 18, colored: true).accessibilityHidden(true)
                Text(item.kind == .task ? item.title : item.rowName).font((large ? Font.title3 : .body).weight(.semibold)).lineLimit(1)
                WatchServerTag(item: item)
                Spacer(minLength: 8)
                WatchSinceTimer(state: state, font: large ? .title3 : .subheadline)
            }
            WatchStatusLine(item: item, preview: state.phase == .waiting, font: large ? .body : .footnote)
                .padding(.leading, large ? 32 : 28)
        }
    }
}

/// What sits under the counts: the sessions waiting on you as rows (two or more), the
/// one waiting on you in detail with its buttons; with nothing waiting, the running
/// sessions the same way. Shared by the lock screen and the expanded island.
struct WatchSessions: View {
    let state: WatchState
    /// StandBy: larger type, no buttons.
    var large = false
    var buttons = true

    var body: some View {
        switch state.phase {
        case .waiting, .working:
            if state.listsRows {
                VStack(alignment: .leading, spacing: large ? 8 : 4) {
                    ForEach(state.listed) { item in
                        WatchListRow(item: item, large: large, showsLater: buttons && state.phase == .waiting)
                    }
                    if let more = WatchCopy.moreLine(state) {
                        Link(destination: state.phase == .waiting ? DeepLink.needsYou.url : DeepLink.work(view: "active").url) {
                            Text(more)
                                .font((large ? Font.subheadline : .caption).weight(.semibold))
                                .foregroundStyle(Color.secondary)
                                .fixedSize()
                        }
                        .padding(.leading, large ? 15 : 13)
                    }
                }
            } else if let head = state.head {
                VStack(alignment: .leading, spacing: large ? 10 : 7) {
                    WatchDetailRow(state: state, item: head, large: large)
                    if buttons { WatchButtons(state: state) }
                }
            } else {
                Text("No sessions running").font(large ? .title3 : .subheadline).foregroundStyle(.secondary)
            }
        case .offline:
            Text(WatchCopy.offlineLine(state))
                .font(large ? .title3 : .subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        case .done:
            if let line = WatchCopy.summaryLine(state) {
                Text(line)
                    .font(large ? .title3 : .subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }
}

/// The buttons under a session shown in detail. Waiting: **Reply…** (or **Message…**,
/// **Open** for a task) + **Later**; `needs_attention` task: **Resume**; `failed` task:
/// **Retry**; a task with a PR: **Open PR**. Working: **Open PR** for a followed task at
/// an open PR, else nothing.
struct WatchButtons: View {
    let state: WatchState
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if let head = state.head, state.phase == .waiting || (state.phase == .working && WatchCopy.prURL(head) != nil) {
            HStack(spacing: 8) {
                if state.phase == .waiting {
                    let acts = WatchCopy.isAttentionTask(head) || WatchCopy.isFailedTask(head)
                    if WatchCopy.isAttentionTask(head) {
                        Button(intent: ResumeTaskIntent(taskId: head.id, serverId: head.serverId)) { pill("Resume", prominent: true) }
                            .buttonStyle(.plain)
                    } else if WatchCopy.isFailedTask(head) {
                        Button(intent: WatchRetryTaskIntent(taskId: head.id, serverId: head.serverId)) { pill("Retry", prominent: true) }
                            .buttonStyle(.plain)
                    }
                    if let url = URL(string: head.link) {
                        Link(destination: url) { pill(WatchCopy.openLabel(head), prominent: !acts) }
                    }
                    if let pr = WatchCopy.prURL(head) {
                        Link(destination: pr) { pill("Open PR", prominent: false) }
                    }
                    Button(intent: LaterIntent(item: head)) { pill("Later", prominent: false) }
                        .buttonStyle(.plain)
                } else if let pr = WatchCopy.prURL(head) {
                    Link(destination: pr) { pill("Open PR", prominent: false) }
                }
            }
        }
    }

    private func pill(_ title: String, prominent: Bool) -> some View {
        Text(title)
            .font(.footnote.weight(.semibold))
            .lineLimit(1)
            // Last resort for four buttons on a 4.7" phone at the largest text size.
            .minimumScaleFactor(0.8)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(prominent ? AnyShapeStyle(WatchCopy.purple) : AnyShapeStyle(.fill.tertiary), in: Capsule())
            .foregroundStyle(prominent ? (scheme == .dark ? Color.black : Color.white) : Color.primary)
    }
}

// MARK: - Dynamic Island regions

/// Needs you: the yellow dot and count. Nothing waiting: the bot, purple while sessions
/// run, grey otherwise.
struct WatchCompactLeading: View {
    let state: WatchState

    var body: some View {
        Group {
            if state.phase == .waiting {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.bubble.fill").font(.caption2).foregroundStyle(StatusColor.green)
                    Text("\(state.needsYouCount)")
                        .font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(StatusColor.green)
                        .contentTransition(.numericText())
                        .widgetAccentable()
                        .fixedSize()
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(state.needsYouCount) need you")
            } else {
                if state.phase == .working, let head = state.head {
                    WhoGlyph(item: head, size: 15, colored: true)
                } else {
                    WatchGlyph(phase: state.phase == .working && state.runningCount == 0 ? .done : state.phase, size: 14)
                }
            }
        }
        .padding(.leading, 2)
        .glanceTypeClamp()
    }
}

/// Running: the purple dot and count. With nothing running, how long the oldest
/// session has waited on you (yellow), or a word: "quiet", "offline", "ended".
struct WatchCompactTrailing: View {
    let state: WatchState

    var body: some View {
        Group {
            switch state.phase {
            case .waiting, .working:
                if state.runningCount > 0 {
                    HStack(spacing: 4) {
                        Image(systemName: "play.fill").font(.system(size: 8)).foregroundStyle(StatusColor.purple)
                        Text("\(state.runningCount)")
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(StatusColor.purple)
                            .contentTransition(.numericText())
                            .fixedSize()
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(state.runningCount) running")
                } else if state.phase == .waiting, let head = state.head {
                    FitTimer(since: head.since, font: .caption.weight(.semibold), style: AnyShapeStyle(StatusColor.green))
                        .widgetAccentable()
                } else {
                    Text("quiet").font(.caption).foregroundStyle(.secondary).fixedSize()
                }
            case .offline:
                Text("offline").font(.caption).foregroundStyle(.secondary).fixedSize()
            case .done:
                Text("ended").font(.caption).foregroundStyle(.tertiary).fixedSize()
            }
        }
        .padding(.trailing, 2)
        .glanceTypeClamp()
    }
}

/// The status dot with the count inside: yellow while waiting, purple while running.
struct WatchMinimal: View {
    let state: WatchState

    var body: some View {
        Group {
            switch state.phase {
            case .waiting:
                ZStack {
                    Circle().fill(StatusColor.green)
                    Text("\(state.needsYouCount)")
                        .font(.system(size: 11, weight: .bold).monospacedDigit())
                        .foregroundStyle(.black)
                        .minimumScaleFactor(0.7)
                        .contentTransition(.numericText())
                }
                .frame(width: 20, height: 20)
                .widgetAccentable()
            case .working where state.runningCount > 0:
                ZStack {
                    Circle().fill(StatusColor.purple)
                    Text("\(state.runningCount)")
                        .font(.system(size: 11, weight: .bold).monospacedDigit())
                        .foregroundStyle(.white)
                        .minimumScaleFactor(0.7)
                        .contentTransition(.numericText())
                }
                .frame(width: 20, height: 20)
            default:
                WatchPhaseDot(phase: state.phase, size: 10)
            }
        }
    }
}

/// `3` / `need you`, yellow; "Offline" or "Ended" when there is nothing to count.
struct WatchExpandedLeading: View {
    let state: WatchState

    var body: some View {
        Group {
            switch state.phase {
            case .working:
                word(state.runningCount > 0 ? "In progress" : "All clear", systemImage: state.runningCount > 0 ? "circle.dotted" : "checkmark.circle")
            case .waiting:
                WatchCount(count: state.needsYouCount, noun: state.needsYouCount == 1 ? "needs you" : "need you", color: StatusColor.green)
                    .widgetAccentable(state.needsYouCount > 0)
            case .offline:
                word("Offline", systemImage: "wifi.slash")
            case .done:
                word("Ended", systemImage: "checkmark")
            }
        }
        .padding(.leading, 4)
        .glanceTypeClamp()
    }

    private func word(_ text: String, systemImage: String) -> some View {
        Label(text, systemImage: systemImage)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .fixedSize()
    }
}

/// `14` / `running`, purple.
struct WatchExpandedTrailing: View {
    let state: WatchState

    var body: some View {
        Group {
            switch state.phase {
            case .waiting, .working:
                WatchCount(count: state.runningCount, noun: "running", color: StatusColor.purple, alignment: .trailing)
            case .offline, .done:
                EmptyView()
            }
        }
        .padding(.trailing, 4)
        .glanceTypeClamp()
    }
}

/// The sessions under the two counts: the list, or one session and its buttons.
struct WatchExpandedBottom: View {
    let state: WatchState

    var body: some View {
        WatchSessions(state: state)
            .padding(.horizontal, 4)
            .padding(.top, 6)
            .glanceTypeClamp()
    }
}

// MARK: - Lock screen / StandBy

/// A phase headline and two live counts, then the work and its contextual actions.
/// Lock Screen owns the rounded outer container; keep 16-point content margins.
struct WatchLockScreenView: View {
    let state: WatchState
    var isStale = false
    @Environment(\.isActivityFullscreen) private var fullscreen

    var body: some View {
        VStack(alignment: .leading, spacing: fullscreen ? 12 : 9) {
            HStack(alignment: .center, spacing: 8) {
                WatchGlyph(phase: state.phase == .working && state.runningCount == 0 ? .done : state.phase, size: fullscreen ? 22 : 15)
                Text(WatchCopy.title(state))
                    .font((fullscreen ? Font.title3 : .subheadline).weight(.semibold))
                    .lineLimit(1).layoutPriority(1)
                Spacer(minLength: 4)
                if isStale, state.phase != .offline {
                    Label("Updated \(GlanceStyle.time(state.asOf))", systemImage: "clock")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                } else if state.phase == .waiting, state.runningCount > 0 {
                    Label("\(state.runningCount) running", systemImage: "play.fill")
                        .font(.caption2.monospacedDigit()).foregroundStyle(.secondary).fixedSize()
                }
            }
            WatchSessions(state: state, large: fullscreen, buttons: !fullscreen)
        }
        .padding(16)
        .glanceTypeClamp()
    }
}

/// The Watch gets its own composition, instead of the system recomposing the two
/// compact Island regions. iOS 17 keeps the original Lock Screen configuration.
@available(iOS 18.0, *)
struct AdaptiveWatchActivity: View {
    let state: WatchState
    var isStale = false
    @Environment(\.activityFamily) private var family

    var body: some View {
        switch family {
        case .small: WatchSmartStackView(state: state, isStale: isStale)
        default: WatchLockScreenView(state: state, isStale: isStale)
        }
    }
}

/// One priority, one session, and at most one direct action for the wrist.
/// Tapping the card retains the system handoff to this session on iPhone.
struct WatchSmartStackView: View {
    let state: WatchState
    var isStale = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                WatchGlyph(phase: state.phase == .working && state.runningCount == 0 ? .done : state.phase, size: 12)
                Text(WatchCopy.title(state)).font(.caption.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 0)
            }
            if (state.phase == .waiting || state.phase == .working), let head = state.head {
                HStack(spacing: 6) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(head.rowName).font(.headline).lineLimit(1)
                        HStack(spacing: 4) {
                            WhoGlyph(item: head, size: 10).accessibilityHidden(true)
                            Text(head.isSnoozed() ? "Later" : head.statusWord)
                                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            Text(GlancePolicy.waitText(since: head.since, now: state.asOf))
                                .font(.caption2.monospacedDigit()).foregroundStyle(.secondary).fixedSize()
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if state.phase == .waiting, !isStale { WatchWristAction(item: head) }
                }
                if isStale {
                    Text("Updated \(GlanceStyle.time(state.asOf))").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                } else if state.rowCount > 1 {
                    Text("+\(state.rowCount - 1) more").font(.caption2).foregroundStyle(.secondary)
                }
            } else {
                Text(state.phase == .offline ? "Reconnect on iPhone" : (WatchCopy.summaryLine(state) ?? "You're all caught up"))
                    .font(.subheadline.weight(.medium)).lineLimit(2)
                if state.phase == .offline {
                    Text("Since \(GlanceStyle.time(state.offlineSince ?? state.asOf))")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .glanceTypeClamp()
    }
}

struct WatchWristAction: View {
    let item: WatchItem

    var body: some View {
        Group {
            if WatchCopy.isFailedTask(item) {
                Button(intent: WatchRetryTaskIntent(taskId: item.id, serverId: item.serverId)) { symbol("arrow.clockwise") }
                    .accessibilityLabel("Retry \(item.rowName)")
            } else if WatchCopy.isAttentionTask(item) {
                Button(intent: ResumeTaskIntent(taskId: item.id, serverId: item.serverId)) { symbol("play.fill") }
                    .accessibilityLabel("Resume \(item.rowName)")
            } else {
                Button(intent: LaterIntent(item: item)) { symbol("moon.zzz") }
                    .accessibilityLabel("Remind me later: \(item.rowName)")
            }
        }
        .buttonStyle(.plain)
    }

    private func symbol(_ name: String) -> some View {
        Image(systemName: name).font(.caption.weight(.semibold)).foregroundStyle(Color.primary)
            .frame(width: 32, height: 32).background(.fill.tertiary, in: Circle())
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
        static let busy = WatchItem(
            kind: .local, id: "t4", title: "claude-code · inventory", mono: "inventory",
            reason: nil, since: Date().addingTimeInterval(-9 * 60), state: "working",
            link: DeepLink.local("t4", compose: true).url.absoluteString,
            source: .localTerminal, when: "now", where: WatchWhere(target: .machine, detail: "MacBook Pro · ~/repos/inventory"),
            who: "claude-code", then: .waitsForMe, statusLabel: "working")
        /// A row from a server that predates the session chips: every fallback kicks in.
        static let legacy = WatchItem(
            kind: .local, id: "t3", title: "codex · cli", mono: "optio/apps/cli",
            reason: "Gone quiet — check in", since: Date().addingTimeInterval(-20 * 60), state: "needs_you",
            link: DeepLink.local("t3", compose: true).url.absoluteString)

        /// Five need you: the oldest two listed, then "+3 more".
        static let waiting = WatchState(phase: .waiting, head: attentionTask, others: [head, second], needsYouCount: 5, runningCount: 2, waitingCount: 1, recurringCount: 4, agentCount: 2)
        static let waitingThree = WatchState(phase: .waiting, head: attentionTask, others: [head, second], needsYouCount: 3, runningCount: 2, waitingCount: 1, recurringCount: 4, agentCount: 2)
        static let waitingTwo = WatchState(phase: .waiting, head: head, others: [second], needsYouCount: 2, runningCount: 3, waitingCount: 1, recurringCount: 4, agentCount: 2)
        static let waitingOne = WatchState(phase: .waiting, head: head, needsYouCount: 1, runningCount: 2, waitingCount: 1, recurringCount: 4, agentCount: 2)
        static let waitingTask = WatchState(phase: .waiting, head: attentionTask, needsYouCount: 1, runningCount: 1)
        static let waitingLegacy = WatchState(phase: .waiting, head: legacy, needsYouCount: 1, runningCount: 0)
        /// Nothing waiting, three running: all listed, newest first.
        static let working = WatchState(phase: .working, head: agent, others: [busy, task], needsYouCount: 0, runningCount: 3, waitingCount: 1, recurringCount: 4, agentCount: 2)
        static let workingMany = WatchState(phase: .working, head: agent, others: [busy, task], needsYouCount: 0, runningCount: 7, waitingCount: 1, recurringCount: 4, agentCount: 2)
        static let workingTask = WatchState(phase: .working, head: task, needsYouCount: 0, runningCount: 1)
        static let workingAgent = WatchState(phase: .working, head: agent, needsYouCount: 0, runningCount: 1)
        static let offline = WatchState(phase: .offline, needsYouCount: 0, runningCount: 0, offlineSince: Date().addingTimeInterval(-6 * 60))
        static let done = WatchState(phase: .done, summary: "Sessions ended. 3 answered, 1 PR merged.")
    }
}

#Preview("Waiting", as: .content, using: WatchAttributes(userId: "preview")) {
    LegacyWatchLiveActivity()
} contentStates: {
    WatchState.Samples.waiting
    WatchState.Samples.waitingThree
    WatchState.Samples.waitingTwo
    WatchState.Samples.waitingOne
    WatchState.Samples.waitingTask
    WatchState.Samples.waitingLegacy
}

#Preview("Working", as: .content, using: WatchAttributes(userId: "preview")) {
    LegacyWatchLiveActivity()
} contentStates: {
    WatchState.Samples.working
    WatchState.Samples.workingMany
    WatchState.Samples.workingTask
    WatchState.Samples.workingAgent
}

#Preview("Offline · Done", as: .content, using: WatchAttributes(userId: "preview")) {
    LegacyWatchLiveActivity()
} contentStates: {
    WatchState.Samples.offline
    WatchState.Samples.done
}

#Preview("Island expanded", as: .dynamicIsland(.expanded), using: WatchAttributes(userId: "preview")) {
    LegacyWatchLiveActivity()
} contentStates: {
    WatchState.Samples.waiting
    WatchState.Samples.waitingOne
    WatchState.Samples.working
    WatchState.Samples.offline
    WatchState.Samples.done
}

#Preview("Island compact", as: .dynamicIsland(.compact), using: WatchAttributes(userId: "preview")) {
    LegacyWatchLiveActivity()
} contentStates: {
    WatchState.Samples.waiting
    WatchState.Samples.working
}

#Preview("Island minimal", as: .dynamicIsland(.minimal), using: WatchAttributes(userId: "preview")) {
    LegacyWatchLiveActivity()
} contentStates: {
    WatchState.Samples.waiting
    WatchState.Samples.working
}
