import ActivityKit
import SwiftUI
import WidgetKit

/// The one Optio Live Activity: "the thing waiting on you, plus how many more".
/// Region table and copy: docs/design/ios-glanceable-surfaces.md §2a.
///
/// Purple appears only when something needs you. Working is `.secondary`, offline is
/// plain words, done is a summary line. The only live elements are the system timers.
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
                    WatchButtons(state: state)
                }
            } compactLeading: {
                WatchGlyph(phase: state.phase)
            } compactTrailing: {
                WatchCompactTrailing(state: state)
            } minimal: {
                WatchMinimal(state: state)
            }
            .widgetURL(WatchCopy.url(for: state))
            .keylineTint(state.phase == .waiting ? WatchCopy.purple : .secondary)
        }
    }
}

// MARK: - Copy & styling

enum WatchCopy {
    /// #6d28d9 — "you". Only ever shown while something needs you.
    static let purple = Color(red: 0x6D / 255, green: 0x28 / 255, blue: 0xD9 / 255)
    /// One symbol, hierarchical rendering, no wordmark.
    static let glyph = "terminal.fill"

    static func headline(_ state: WatchState) -> String {
        switch state.phase {
        case .waiting: return "Needs you"
        case .working: return "Working"
        case .offline: return "Offline"
        case .done: return "Quiet"
        }
    }

    static func offlineLine(_ state: WatchState) -> String {
        let t = (state.offlineSince ?? state.asOf).formatted(date: .omitted, time: .shortened)
        return "Laptop unreachable since \(t)"
    }

    static func workingLine(_ state: WatchState) -> String {
        state.runningCount == 0 ? "quiet" : "\(state.runningCount) running"
    }

    static func reason(_ item: WatchItem) -> String {
        item.reason ?? "Needs you"
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

/// "● MacBook" after the mono path when more than one server is paired, so the
/// island says which laptop is asking. Nothing with a single server.
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

struct WatchGlyph: View {
    let phase: WatchState.Phase
    var size: Font = .title3

    var body: some View {
        Image(systemName: WatchCopy.glyph)
            .symbolRenderingMode(.hierarchical)
            .font(size)
            .foregroundStyle(phase == .waiting ? AnyShapeStyle(WatchCopy.purple) : AnyShapeStyle(.secondary))
            .widgetAccentable(phase == .waiting)
    }
}

// MARK: - Dynamic Island regions

struct WatchCompactTrailing: View {
    let state: WatchState

    var body: some View {
        switch state.phase {
        case .waiting:
            HStack(spacing: 4) {
                MonoText(text: state.head?.mono ?? "", size: .caption, weight: .semibold)
                    .foregroundStyle(WatchCopy.purple)
                    .frame(maxWidth: 64, alignment: .trailing)
                if state.needsYouCount > 1 {
                    Text("+\(state.needsYouCount - 1)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(WatchCopy.purple)
                        .contentTransition(.numericText())
                }
            }
            .widgetAccentable()
        case .working:
            Text(WatchCopy.workingLine(state))
                .font(.caption)
                .foregroundStyle(.secondary)
                .contentTransition(.numericText())
        case .offline:
            Text("offline").font(.caption).foregroundStyle(.secondary)
        case .done:
            Text("quiet").font(.caption).foregroundStyle(.tertiary)
        }
    }
}

struct WatchMinimal: View {
    let state: WatchState

    var body: some View {
        if state.phase == .waiting {
            ZStack {
                Circle().fill(WatchCopy.purple)
                Text("\(state.needsYouCount)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
                    .contentTransition(.numericText())
            }
            .frame(width: 20, height: 20)
            .widgetAccentable()
        } else {
            WatchGlyph(phase: state.phase, size: .body)
        }
    }
}

struct WatchExpandedLeading: View {
    let state: WatchState

    var body: some View {
        HStack(spacing: 6) {
            WatchGlyph(phase: state.phase)
            Text(WatchCopy.headline(state))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(state.phase == .waiting ? AnyShapeStyle(WatchCopy.purple) : AnyShapeStyle(.secondary))
        }
        .padding(.leading, 4)
    }
}

struct WatchExpandedCenter: View {
    let state: WatchState

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            switch state.phase {
            case .waiting:
                if let head = state.head {
                    HStack(spacing: 6) {
                        MonoText(text: head.mono)
                        WatchServerTag(item: head)
                    }
                    Text(head.preview ?? WatchCopy.reason(head))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .privacySensitive(head.preview != nil)
                }
            case .working:
                if let head = state.head {
                    Text(head.title).font(.subheadline.weight(.medium)).lineLimit(1)
                    Text(timerInterval: head.since...head.since.addingTimeInterval(8 * 3600), countsDown: false)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                } else {
                    Text("Nothing running").font(.subheadline).foregroundStyle(.secondary)
                }
            case .offline:
                Text(WatchCopy.offlineLine(state)).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            case .done:
                Text(state.summary ?? "Quiet.").font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct WatchExpandedTrailing: View {
    let state: WatchState

    var body: some View {
        switch state.phase {
        case .waiting:
            if let head = state.head {
                Text(head.since, style: .timer)
                    .font(.subheadline.monospacedDigit().weight(.semibold))
                    .foregroundStyle(WatchCopy.purple)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 52, alignment: .trailing)
                    .widgetAccentable()
            }
        case .working:
            Text("\(state.runningCount)")
                .font(.title3.monospacedDigit().weight(.semibold))
                .foregroundStyle(.secondary)
                .contentTransition(.numericText())
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
                        Link(destination: url) { pill("Reply…", prominent: !WatchCopy.isAttentionTask(head) && !WatchCopy.isFailedTask(head)) }
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
            .padding(.top, 4)
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

/// Same hierarchy as the expanded island: two lines plus the button row. StandBy
/// (`isActivityFullscreen`) gets larger mono type and drops the preview line.
struct WatchLockScreenView: View {
    let state: WatchState
    @Environment(\.isActivityFullscreen) private var fullscreen

    var body: some View {
        VStack(alignment: .leading, spacing: fullscreen ? 10 : 6) {
            HStack(spacing: 6) {
                WatchGlyph(phase: state.phase, size: fullscreen ? .title : .title3)
                Text(WatchCopy.headline(state))
                    .font((fullscreen ? Font.title3 : .subheadline).weight(.semibold))
                    .foregroundStyle(state.phase == .waiting ? AnyShapeStyle(WatchCopy.purple) : AnyShapeStyle(.secondary))
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
                HStack(spacing: 6) {
                    if state.needsYouCount > 1 {
                        Text("+\(state.needsYouCount - 1)").font(.caption.weight(.semibold)).foregroundStyle(WatchCopy.purple)
                    }
                    Text(head.since, style: .timer)
                        .font((fullscreen ? Font.title3 : .subheadline).monospacedDigit().weight(.semibold))
                        .foregroundStyle(WatchCopy.purple)
                        .frame(minWidth: 44, alignment: .trailing)
                }
                .widgetAccentable()
            }
        case .working:
            Text(WatchCopy.workingLine(state)).font(.caption).foregroundStyle(.secondary).contentTransition(.numericText())
        case .offline, .done:
            EmptyView()
        }
    }

    @ViewBuilder private var center: some View {
        switch state.phase {
        case .waiting:
            if let head = state.head {
                HStack(spacing: 6) {
                    MonoText(text: head.mono, size: fullscreen ? .title2 : .body)
                    WatchServerTag(item: head, size: fullscreen ? .footnote : .caption2)
                }
                if fullscreen {
                    Text(WatchCopy.reason(head)).font(.body).foregroundStyle(.secondary).lineLimit(1)
                } else {
                    Text(head.preview ?? WatchCopy.reason(head))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .privacySensitive(head.preview != nil)
                }
            }
        case .working:
            if let head = state.head {
                HStack(spacing: 8) {
                    Text(head.title).font(fullscreen ? .title3 : .subheadline).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(timerInterval: head.since...head.since.addingTimeInterval(8 * 3600), countsDown: false)
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        .frame(maxWidth: 64, alignment: .trailing)
                }
            } else {
                Text("Nothing running").font(.subheadline).foregroundStyle(.secondary)
            }
        case .offline:
            Text(WatchCopy.offlineLine(state)).font(fullscreen ? .title3 : .subheadline).foregroundStyle(.secondary)
        case .done:
            Text(state.summary ?? "Quiet.").font(fullscreen ? .title3 : .subheadline).foregroundStyle(.secondary)
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
            link: DeepLink.local("t1", compose: true).url.absoluteString)
        static let second = WatchItem(
            kind: .local, id: "t2", title: "claude-code · api", mono: "optio/apps/api",
            reason: "Claude stopped — reply to continue", since: Date().addingTimeInterval(-90), state: "needs_you",
            link: DeepLink.local("t2", compose: true).url.absoluteString)
        static let task = WatchItem(
            kind: .task, id: "task1", title: "Fix login redirect loop", mono: "fix/login-redirect",
            reason: "PR #581 open · CI running", since: Date().addingTimeInterval(-12 * 60), state: "pr_opened",
            link: DeepLink.task("task1").url.absoluteString, prUrl: "https://github.com/jonwiggins/optio/pull/581")
        static let attentionTask = WatchItem(
            kind: .task, id: "task2", title: "Migrate settings to Drizzle", mono: "feat/settings-drizzle",
            reason: "Merge conflict — resume?", since: Date().addingTimeInterval(-7 * 60), state: "needs_attention",
            link: DeepLink.task("task2").url.absoluteString, prUrl: "https://github.com/jonwiggins/optio/pull/590")

        static let waiting = WatchState(phase: .waiting, head: head, others: [second], needsYouCount: 3, runningCount: 2)
        static let waitingTask = WatchState(phase: .waiting, head: attentionTask, needsYouCount: 1, runningCount: 1)
        static let working = WatchState(phase: .working, head: task, needsYouCount: 0, runningCount: 3)
        static let offline = WatchState(phase: .offline, needsYouCount: 0, runningCount: 0, offlineSince: Date().addingTimeInterval(-6 * 60))
        static let done = WatchState(phase: .done, summary: "Quiet. 3 answered, 1 PR merged.")
    }
}

#Preview("Waiting", as: .content, using: WatchAttributes(userId: "preview")) {
    WatchLiveActivity()
} contentStates: {
    WatchState.Samples.waiting
    WatchState.Samples.waitingTask
}

#Preview("Working", as: .content, using: WatchAttributes(userId: "preview")) {
    WatchLiveActivity()
} contentStates: {
    WatchState.Samples.working
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
