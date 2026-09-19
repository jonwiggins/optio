import SwiftUI

/// Standard header for detail screens (Task, Job run, Review, Agent, Session,
/// Local terminal): a material block with the badge, a title-less state line
/// (`Running · 3m 12s · claude-sonnet`) and a single accent row only when the
/// thing needs you.
struct DetailHeader<Accessory: View>: View {
    let state: String
    var tone: Tone? = nil
    /// `·`-joined facts: duration, model, repo, branch. Mono parts via `Text.mono`.
    var line: Text? = nil
    /// Second line (mono path, PR link text).
    var secondary: Text? = nil
    /// Accent row shown only when the item needs the user.
    var needsYou: String? = nil
    /// Show the shared Claude usage pill (`AccountUsagePill`) at the end of the
    /// second line — the number that decides whether another session can start.
    var showsUsage = false
    @ViewBuilder var accessory: Accessory

    init(state: String, tone: Tone? = nil, line: Text? = nil, secondary: Text? = nil, needsYou: String? = nil,
         showsUsage: Bool = false, @ViewBuilder accessory: () -> Accessory = { EmptyView() }) {
        self.state = state
        self.tone = tone
        self.line = line
        self.secondary = secondary
        self.needsYou = needsYou
        self.showsUsage = showsUsage
        self.accessory = accessory()
    }

    private var resolvedTone: Tone { tone ?? Tone.forState(state) }

    private func secondaryText(_ text: Text) -> some View {
        text.font(.monoFootnote).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            HStack(spacing: Spacing.s) {
                StatusBadge(text: state, tone: resolvedTone)
                if let line {
                    line.font(.subheadline).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 0)
                accessory
            }
            if let secondary, showsUsage {
                // Path and pill share a line when both fit; otherwise the pill takes its own.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: Spacing.s) {
                        secondaryText(secondary)
                        Spacer(minLength: 0)
                        AccountUsagePill().fixedSize()
                    }
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        secondaryText(secondary)
                        AccountUsagePill()
                    }
                }
            } else if let secondary {
                secondaryText(secondary)
            } else if showsUsage {
                AccountUsagePill()
            }
            if let needsYou {
                HStack(spacing: 6) {
                    StateDot(tone: .accent)
                    Text(needsYou).font(.footnote.weight(.medium)).foregroundStyle(Tone.accent.textStyle)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Spacing.l)
        .padding(.vertical, Spacing.m)
        .background(.regularMaterial)
        .overlay(alignment: .bottom) { Divider() }
        .modifier(UsageObserverIf(enabled: showsUsage))
    }
}

/// `observesUsage()` only for headers that show the pill.
private struct UsageObserverIf: ViewModifier {
    let enabled: Bool
    func body(content: Content) -> some View {
        if enabled { content.observesUsage() } else { content }
    }
}

/// One message bubble: user = trailing on a secondary fill, agent = leading plain prose.
struct MessageBubble: View {
    enum Role { case user, agent, system }
    let role: Role
    let text: String
    var meta: String? = nil
    var pending = false

    var body: some View {
        VStack(alignment: role == .user ? .trailing : .leading, spacing: 3) {
            Text(LocalizedStringKey(text))
                .font(role == .system ? .footnote : .body)
                .foregroundStyle(role == .system ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                .textSelection(.enabled)
                .padding(.horizontal, role == .user ? Spacing.m : 0)
                .padding(.vertical, role == .user ? Spacing.s : 0)
                .background {
                    if role == .user {
                        Radius.bubbleShape.fill(.fill.secondary)
                    }
                }
                .frame(maxWidth: 320, alignment: role == .user ? .trailing : .leading)
            if let meta {
                Text(meta).font(.caption2).foregroundStyle(pending ? AnyShapeStyle(AppTheme.accent) : AnyShapeStyle(.tertiary))
            }
        }
        .frame(maxWidth: .infinity, alignment: role == .user ? .trailing : .leading)
    }
}

/// Monochrome pipeline strip: done = primary, current = accent, future = quaternary.
struct PipelineStrip: View {
    let steps: [String]
    let current: Int
    var failed = false

    var body: some View {
        HStack(spacing: Spacing.xs) {
            ForEach(Array(steps.enumerated()), id: \.offset) { i, step in
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Capsule().fill(fill(i)).frame(height: 3)
                    Text(step).font(.caption2).foregroundStyle(i <= current ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary)).lineLimit(1)
                }
            }
        }
    }

    private func fill(_ i: Int) -> AnyShapeStyle {
        if i < current { return AnyShapeStyle(.primary) }
        if i == current { return AnyShapeStyle(failed ? Color.red : AppTheme.accent) }
        return AnyShapeStyle(.quaternary)
    }
}

/// Segmented section switcher inside a detail screen (Logs · Activity · …).
struct DetailTabs<T: Hashable>: View {
    let options: [(T, String)]
    @Binding var selection: T

    var body: some View {
        Picker("Section", selection: $selection) {
            ForEach(options, id: \.0) { value, label in Text(label).tag(value) }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, Spacing.l)
        .padding(.vertical, Spacing.s)
        .sensoryFeedback(.selection, trigger: selection)
    }
}
