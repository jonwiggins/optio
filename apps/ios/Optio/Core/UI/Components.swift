import SwiftUI

// Shared components. Every list, strip, badge and empty state in the app is one
// of these so the screens read as one system (docs/design/ios-ui-review.md §2).

// MARK: - Badge

/// The only uppercase text in the app. Detail headers only — rows use the dot.
struct StatusBadge: View {
    let text: String
    var tone: Tone = .working

    init(text: String, tone: Tone = .working) {
        self.text = text
        self.tone = tone
    }

    /// Badge for a raw state string, coloured through the single state map.
    init(state: String) {
        self.init(text: state, tone: Tone.forState(state))
    }

    var body: some View {
        Text(text.replacingOccurrences(of: "_", with: " "))
            .font(.caption2.weight(.semibold))
            .textCase(.uppercase)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(badgeFill, in: Capsule())
            .foregroundStyle(tone.textStyle)
            .lineLimit(1)
            .fixedSize()
    }

    private var badgeFill: AnyShapeStyle {
        switch tone {
        case .accent, .danger, .success, .working: return AnyShapeStyle(tone.color.opacity(0.14))
        default: return AnyShapeStyle(.fill.tertiary)
        }
    }
}

// MARK: - State dot

/// 6pt state dot. Yellow = needs you (the only element allowed to pulse),
/// purple = working, red = failed. Nothing for done / idle.
struct StateDot: View {
    let tone: Tone
    var size: CGFloat = 7

    var body: some View {
        Image(systemName: "circle.fill")
            .font(.system(size: size))
            .foregroundStyle(tone.color)
            .symbolEffect(.pulse, options: .repeating, isActive: tone == .accent)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

// MARK: - Errors

enum ErrorText {
    /// Plain-language error copy. Decoding failures and rate limits never reach the user raw.
    static func humanize(_ error: Error, what: String? = nil) -> String {
        let subject = what.map { "Couldn't load \($0)" } ?? "Something went wrong"
        if error is DecodingError { return "\(subject) — the server sent something this version of the app doesn't understand." }
        if let api = error as? APIError {
            switch api.status {
            case 429: return "Slow down — the server is rate limiting. Retrying in a moment."
            case 401: return "Your access token was rejected. Sign in again."
            case 403: return "You don't have permission for this."
            case 404: return what.map { "That \($0.hasSuffix("s") ? String($0.dropLast()) : $0) no longer exists." } ?? "Not found."
            case 500...599: return "\(subject) — the server hit an error."
            case 0:
                let m = api.message.lowercased()
                if m.contains("decod") || m.contains("parse") { return "\(subject) — the server sent something this version of the app doesn't understand." }
                if m.contains("offline") || m.contains("connect") || m.contains("network") { return "Can't reach the server. Check your connection." }
                return api.message
            default: return api.message.isEmpty ? subject : api.message
            }
        }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain {
            switch ns.code {
            case NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost: return "You're offline."
            case NSURLErrorTimedOut: return "The server took too long to respond."
            case NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost: return "Can't reach the server."
            default: break
            }
        }
        return error.localizedDescription
    }
}

/// One-line inline error with a Retry text button. Red only on the symbol.
struct ErrorRow: View {
    let error: Error
    var what: String? = nil
    var retry: (() -> Void)?

    init(error: Error, what: String? = nil, retry: (() -> Void)? = nil) {
        self.error = error
        self.what = what
        self.retry = retry
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
            Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
            Text(ErrorText.humanize(error, what: what))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                Button("Retry", action: retry).font(.footnote.weight(.semibold)).buttonStyle(.plain).foregroundStyle(AppTheme.accent)
            }
        }
        .font(.footnote)
        .padding(.vertical, Spacing.xs)
    }
}

// MARK: - Empty state

struct EmptyState: View {
    let title: String
    var systemImage: String = "tray"
    var message: String? = nil
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        ContentUnavailableView {
            Label {
                Text(title).font(.title3.weight(.semibold))
            } icon: {
                Image(systemName: systemImage).fontWeight(.thin).symbolRenderingMode(.hierarchical)
            }
        } description: {
            if let message { Text(message) }
        } actions: {
            if let actionTitle, let action {
                Button(actionTitle, action: action).buttonStyle(.borderedProminent).tint(.primary)
            }
        }
    }
}

// MARK: - Stat strip

struct StatItem: Identifiable, Hashable {
    let key: String
    let label: String
    let value: String
    /// True when the number is zero — rendered tertiary so an idle screen has no colour.
    var isZero: Bool
    /// Only `.accent` (needs you) and `.danger` (failed) are honoured, and only when non-zero.
    var tone: Tone? = nil

    var id: String { key }

    init(_ label: String, _ value: Int, tone: Tone? = nil, key: String? = nil) {
        self.key = key ?? label
        self.label = label
        self.value = "\(value)"
        self.isZero = value == 0
        self.tone = tone
    }

    init(_ label: String, text: String, tone: Tone? = nil, key: String? = nil) {
        self.key = key ?? label
        self.label = label
        self.value = text
        self.isZero = false
        self.tone = tone
    }
}

/// Flat stat strip: one card, hairline dividers, value over label. Optional
/// tappable filter with a 2pt primary underline on the selected tile.
struct StatStrip: View {
    let items: [StatItem]
    var selected: String? = nil
    var onSelect: ((StatItem) -> Void)? = nil
    @State private var tapCount = 0

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { idx, item in
                tile(item)
                if idx < items.count - 1 {
                    Rectangle().fill(.separator).frame(width: 0.5).padding(.vertical, Spacing.m)
                }
            }
        }
        .background(Surface.card, in: Radius.cardShape)
        .sensoryFeedback(.selection, trigger: tapCount)
    }

    private func tile(_ item: StatItem) -> some View {
        let isSelected = selected == item.key
        return Button {
            guard let onSelect else { return }
            tapCount += 1
            onSelect(item)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.value)
                    .font(.statValue)
                    .foregroundStyle(valueStyle(item))
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(item.label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, items.count >= 5 ? Spacing.s : Spacing.m)
            .padding(.vertical, Spacing.m)
            .overlay(alignment: .bottom) {
                if isSelected {
                    Rectangle().fill(.primary).frame(height: 2).padding(.horizontal, items.count >= 5 ? Spacing.s : Spacing.m)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(onSelect == nil)
        .accessibilityLabel("\(item.label): \(item.value)")
    }

    private func valueStyle(_ item: StatItem) -> AnyShapeStyle {
        if item.isZero { return AnyShapeStyle(.tertiary) }
        switch item.tone {
        case .accent: return AnyShapeStyle(AppTheme.accent)
        case .danger: return AnyShapeStyle(.red)
        default: return AnyShapeStyle(.primary)
        }
    }
}

// MARK: - Chips (filters only)

/// Horizontally scrolling filter chips. Selected = primary fill with inverted text.
/// For section switching use a segmented `Picker` in the toolbar, not this.
struct ChipPicker<T: Hashable>: View {
    let options: [(T, String)]
    @Binding var selection: T

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Spacing.s) {
                ForEach(options, id: \.0) { value, label in
                    let isSelected = selection == value
                    Button {
                        withAnimation(.snappy) { selection = value }
                    } label: {
                        Text(label)
                            .font(.subheadline.weight(isSelected ? .semibold : .regular))
                            .foregroundStyle(isSelected ? Color(.systemBackground) : Color.primary)
                            .padding(.horizontal, Spacing.m)
                            .padding(.vertical, 6)
                            .background(isSelected ? AnyShapeStyle(Color.primary) : AnyShapeStyle(.fill.tertiary), in: Capsule())
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Spacing.l)
            .padding(.vertical, Spacing.s)
        }
        .sensoryFeedback(.selection, trigger: selection)
    }
}

// MARK: - Section header

/// Footnote-semibold, secondary, sentence case; optional trailing chevron when tappable.
struct SectionHeader: View {
    let title: String
    var detail: String? = nil
    var tone: Tone? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        Button {
            action?()
        } label: {
            HStack(spacing: Spacing.xs) {
                // Explicit label colours: list section headers already dim their content, so a
                // hierarchical `.secondary` here would land on tertiary.
                Text(title).font(.sectionHeader).foregroundStyle(tone?.textStyle ?? AnyShapeStyle(Color(.secondaryLabel)))
                if let detail { Text(detail).font(.footnote).foregroundStyle(Color(.tertiaryLabel)) }
                Spacer(minLength: 0)
                if action != nil {
                    Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(Color(.tertiaryLabel))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
    }
}

// MARK: - Row

/// The one list row: leading state dot (only when state ≠ done), body title,
/// one `·`-joined meta line, optional tertiary footer, trailing meta.
struct OptioRow: View {
    let title: String
    var tone: Tone? = nil
    var meta: Text? = nil
    var trailing: String? = nil
    var trailingTone: Tone? = nil
    var footer: Text? = nil
    var titleLineLimit = 2

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.s) {
            if let tone, tone.showsDot {
                StateDot(tone: tone).padding(.top, 7)
            }
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text(title).font(.body).foregroundStyle(.primary).lineLimit(titleLineLimit)
                if let meta {
                    meta.font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
                if let footer {
                    footer.font(.footnote).foregroundStyle(.tertiary).lineLimit(2)
                }
            }
            if let trailing {
                Spacer(minLength: Spacing.s)
                Text(trailing)
                    .font(.footnote)
                    .foregroundStyle(trailingTone?.textStyle ?? AnyShapeStyle(.tertiary))
                    .monospacedDigit()
                    .lineLimit(1)
                    .padding(.top, 3)
            }
        }
        .padding(.vertical, Spacing.row)
    }
}

extension Text {
    /// `Text` in the mono face for paths, branches, `#519`, slugs.
    static func mono(_ s: String) -> Text { Text(s).font(.monoSubheadline) }

    /// Joins meta parts with " · ", dropping nils.
    static func meta(_ parts: [Text?]) -> Text? {
        let present = parts.compactMap { $0 }
        guard let first = present.first else { return nil }
        return present.dropFirst().reduce(first) { $0 + Text(" · ") + $1 }
    }

    static func meta(_ parts: [String?]) -> Text? {
        meta(parts.compactMap { $0.flatMap { $0.isEmpty ? nil : Text($0) } })
    }
}

// MARK: - Skeleton

/// Three placeholder rows for a list that hasn't loaded. Never a bare spinner.
struct SkeletonRows: View {
    var count = 3
    var body: some View {
        ForEach(0..<count, id: \.self) { i in
            OptioRow(title: i % 2 == 0 ? "Loading a row title that wraps" : "Loading",
                     tone: .working,
                     meta: Text("owner/repo · Claude Code · 2m"),
                     trailing: "1h")
        }
        .redacted(reason: .placeholder)
        .allowsHitTesting(false)
    }
}

/// Placeholder strip while stats load.
struct SkeletonStrip: View {
    var labels: [String] = ["Running", "Queued", "Needs you", "Failed"]
    var body: some View {
        StatStrip(items: labels.map { StatItem($0, 12) })
            .redacted(reason: .placeholder)
            .allowsHitTesting(false)
    }
}

// MARK: - Date helpers

extension Date {
    var relativeDescription: String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: self, relativeTo: .now)
    }

    /// "Today", "Yesterday", "Sep 15" for day section headers.
    var dayHeader: String {
        let cal = Calendar.current
        if cal.isDateInToday(self) { return "Today" }
        if cal.isDateInYesterday(self) { return "Yesterday" }
        return formatted(.dateTime.month(.abbreviated).day())
    }
}

extension String {
    /// Parses an ISO-8601 timestamp string (as many API rows carry dates as strings).
    var isoDate: Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: self) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: self)
    }

    var relativeDescription: String { isoDate?.relativeDescription ?? self }

    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }

    /// Last path component-ish name for a directory, head-truncated by the caller.
    var pathTail: String {
        let parts = split(separator: "/").filter { !$0.isEmpty }
        let tail = parts.suffix(2).joined(separator: "/")
        return tail.isEmpty ? self : tail
    }
}

// MARK: - Loadable

/// Generic async-loading wrapper: skeleton, an error row with retry, or content.
struct Loadable<Value, Content: View>: View {
    let load: () async throws -> Value
    var what: String? = nil
    @ViewBuilder let content: (Value) -> Content
    @State private var value: Value?
    @State private var error: Error?

    var body: some View {
        Group {
            if let value {
                content(value)
            } else if let error {
                List { ErrorRow(error: error, what: what) { Task { await run() } } }.listStyle(.plain)
            } else {
                List { SkeletonRows() }.listStyle(.plain)
            }
        }
        .task { await run() }
        .refreshable { await run() }
    }

    private func run() async {
        do { value = try await load(); error = nil } catch { self.error = error }
    }
}

// MARK: - Liquid Glass helpers

extension View {
    /// Glass on iOS 26, thin material below. For things that float over content only.
    @ViewBuilder
    func floatingGlass(in shape: some Shape = Capsule()) -> some View {
        if #available(iOS 26, *) {
            self.glassEffect(.regular, in: shape)
        } else {
            self.background(.regularMaterial, in: shape)
        }
    }

    /// Glass button chrome on iOS 26; bordered below.
    @ViewBuilder
    func glassButton() -> some View {
        if #available(iOS 26, *) {
            self.buttonStyle(.glass)
        } else {
            self.buttonStyle(.bordered)
        }
    }

    /// Prominent glass button on iOS 26; borderedProminent below.
    @ViewBuilder
    func glassProminentButton() -> some View {
        if #available(iOS 26, *) {
            self.buttonStyle(.glassProminent)
        } else {
            self.buttonStyle(.borderedProminent)
        }
    }

    /// Filter changes keep the old content dimmed instead of blanking.
    func dimmedWhileLoading(_ loading: Bool) -> some View {
        opacity(loading ? 0.5 : 1).animation(.snappy, value: loading)
    }

    /// Row surface for cards on the grouped page: no stroke, one colour.
    func cardSurface() -> some View {
        padding(Spacing.m).background(Surface.card, in: Radius.cardShape)
    }
}

/// Banner with a 3pt leading tone bar — replaces stroked / tinted notice cards.
struct NoticeBanner<Content: View>: View {
    var tone: Tone = .accent
    var systemImage: String? = nil
    var title: String? = nil
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.m) {
            Capsule().fill(tone.color).frame(width: 3)
            VStack(alignment: .leading, spacing: Spacing.xs) {
                if let title {
                    HStack(spacing: 6) {
                        if let systemImage { Image(systemName: systemImage).foregroundStyle(tone.textStyle) }
                        Text(title).font(.subheadline.weight(.semibold))
                    }
                }
                content.font(.footnote).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .cardSurface()
    }
}
