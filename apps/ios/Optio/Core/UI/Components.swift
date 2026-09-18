import SwiftUI

/// Small pill used for task/job/agent states. Color derives from a shared palette so
/// every list renders states the same way the web UI does.
struct StatusBadge: View {
    let text: String
    var color: Color = .secondary

    var body: some View {
        Text(text.replacingOccurrences(of: "_", with: " "))
            .font(.caption2.weight(.semibold))
            .textCase(.uppercase)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}

enum StateColor {
    /// Maps any state string from tasks, jobs, runs, sessions, agents, or local
    /// terminals to a color. Unknown states fall back to secondary.
    static func color(for state: String) -> Color {
        switch state {
        case "running", "active", "online", "working", "provisioning", "launching": return .blue
        case "queued", "pending", "waiting_on_deps", "idle", "sticky": return .orange
        case "needs_attention", "needs_you", "stalled", "paused": return .yellow
        case "pr_opened", "reviewing", "review_requested": return AppTheme.accent
        case "completed", "merged", "approved", "success", "exited": return .green
        case "failed", "error", "closed", "offline": return .red
        case "cancelled", "archived", "ended": return .gray
        default: return .secondary
        }
    }
}

struct ErrorBanner: View {
    let error: Error
    var retry: (() -> Void)?

    var body: some View {
        VStack(spacing: 8) {
            Label(error.localizedDescription, systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .multilineTextAlignment(.center)
            if let retry {
                Button("Retry", action: retry).buttonStyle(.bordered).controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity)
        .padding()
        .foregroundStyle(.red)
    }
}

struct EmptyState: View {
    let title: String
    var systemImage: String = "tray"
    var message: String? = nil

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            if let message { Text(message) }
        }
    }
}

struct StatTile: View {
    let title: String
    let value: String
    var color: Color = .primary
    var systemImage: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                if let systemImage { Image(systemName: systemImage) }
                Text(title)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            Text(value)
                .font(.title2.weight(.semibold).monospacedDigit())
                .foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 12))
    }
}

/// Horizontally scrolling chip row used in place of a cramped segmented control.
struct ChipPicker<T: Hashable>: View {
    let options: [(T, String)]
    @Binding var selection: T

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(options, id: \.0) { value, label in
                    Button {
                        selection = value
                    } label: {
                        Text(label)
                            .font(.subheadline.weight(selection == value ? .semibold : .regular))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(selection == value ? AnyShapeStyle(AppTheme.accent.opacity(0.18)) : AnyShapeStyle(.fill.tertiary), in: Capsule())
                            .foregroundStyle(selection == value ? AppTheme.accent : .primary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
        }
    }
}

extension Date {
    var relativeDescription: String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: self, relativeTo: .now)
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
}

/// Generic async-loading wrapper: shows a spinner, an error with retry, or content.
struct Loadable<Value, Content: View>: View {
    let load: () async throws -> Value
    @ViewBuilder let content: (Value) -> Content
    @State private var value: Value?
    @State private var error: Error?

    var body: some View {
        Group {
            if let value {
                content(value)
            } else if let error {
                ErrorBanner(error: error) { Task { await run() } }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { await run() }
        .refreshable { await run() }
    }

    private func run() async {
        do { value = try await load(); error = nil } catch { self.error = error }
    }
}

/// Stat tiles that always fit the screen width: wraps into rows instead of scrolling
/// off the edge. Use for the counts strip at the top of list screens.
struct StatGrid<Content: View>: View {
    var minimum: CGFloat = 86
    @ViewBuilder let content: Content

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: minimum), spacing: 8)], spacing: 8) {
            content
        }
    }
}
