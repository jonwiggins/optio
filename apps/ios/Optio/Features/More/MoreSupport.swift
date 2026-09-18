import SwiftUI
import Observation

// MARK: - Role context

/// Role + workspace context for the More tab.
///
/// `SessionStore.user?.role` is decoded from a `role` key, but `/api/auth/me`
/// actually returns `workspaceRole`, so it is usually nil. This context re-reads
/// `/api/auth/me` with both keys and exposes a resolved role. Every mutation
/// still tolerates a 403 gracefully — the role only decides what to show.
@Observable
@MainActor
final class MoreContext {
    private(set) var role: String?
    private(set) var workspaceId: String?
    private(set) var email: String?
    private(set) var displayName: String?
    private(set) var authDisabled = false

    var isAdmin: Bool { authDisabled || role == "admin" }
    var isMember: Bool { authDisabled || role == "admin" || role == "member" }

    func refresh(api: APIClient, session: SessionStore) async {
        struct Me: Decodable {
            struct User: Decodable {
                var id: String?
                var email: String?
                var displayName: String?
                var role: String?
                var workspaceRole: String?
                var workspaceId: String?
            }
            var user: User
            var authDisabled: Bool?
        }
        if let me = try? await api.get("/api/auth/me", as: Me.self) {
            role = me.user.workspaceRole ?? me.user.role ?? session.user?.role
            workspaceId = session.workspaceId ?? me.user.workspaceId
            email = me.user.email
            displayName = me.user.displayName
            authDisabled = me.authDisabled ?? false
        } else {
            role = session.user?.role
            workspaceId = session.workspaceId ?? session.user?.workspaceId
            email = session.user?.email
            displayName = session.user?.displayName
        }
    }
}

// MARK: - Error presentation

extension View {
    /// Presents `message` as a danger toast whenever it becomes non-nil.
    func moreErrorAlert(_ message: Binding<String?>) -> some View {
        errorToast(message)
    }
}

extension Error {
    /// Human-readable text; a 403 gets a friendlier hint.
    var moreDescription: String {
        if let api = self as? APIError {
            if api.status == 403 { return "You don't have permission to do that. \(api.message)" }
            return api.message
        }
        return localizedDescription
    }
}

// MARK: - Small shared UI

/// Key/value line used in detail screens.
struct MoreInfoRow: View {
    let label: String
    let value: String
    var mono = false

    var body: some View {
        HStack(alignment: .top) {
            Text(label).foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value)
                .font(mono ? .footnote.monospaced() : .body)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
    }
}

/// Monospace block for template bodies, payloads and rendered previews.
struct MoreCodeBlock: View {
    let text: String
    var lineLimit: Int? = nil

    var body: some View {
        Text(text.isEmpty ? " " : text)
            .font(.caption.monospaced())
            .textSelection(.enabled)
            .lineLimit(lineLimit)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 8))
    }
}

/// Copies `text` to the pasteboard and shows a brief checkmark.
struct MoreCopyButton: View {
    let text: String
    var label = "Copy"
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = text
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        } label: {
            Label(copied ? "Copied" : label, systemImage: copied ? "checkmark" : "doc.on.doc")
        }
    }
}

/// Inline chip list for tags such as webhook events or agent types.
struct MoreChipCloud: View {
    let items: [String]

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(items, id: \.self) { item in
                Text(item)
                    .font(.caption2.monospaced())
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.fill.tertiary, in: Capsule())
            }
        }
    }
}

/// Minimal wrapping layout for chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: width == .infinity ? x : width, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

// MARK: - Constants mirrored from the web UI

enum MoreAgentTypes {
    static let all: [(String, String)] = [
        ("claude-code", "Claude Code"),
        ("codex", "OpenAI Codex"),
        ("copilot", "GitHub Copilot"),
        ("gemini", "Google Gemini"),
        ("opencode", "OpenCode"),
        ("cursor", "Cursor"),
    ]

    static func label(_ value: String) -> String {
        all.first { $0.0 == value }?.1 ?? value
    }
}

enum MoreImagePresets {
    static let all: [(String, String, String)] = [
        ("base", "Base", "Git, Node.js, Python 3, gh CLI, glab CLI, Claude Code. Minimal footprint."),
        ("node", "Node.js", "Base + pnpm, yarn, bun, native build tools."),
        ("python", "Python", "Base + pip, uv, poetry, venv support."),
        ("go", "Go", "Base + Go 1.23, protoc, gopls."),
        ("rust", "Rust", "Base + rustup, cargo, cargo-nextest."),
        ("ruby", "Ruby", "Base + rbenv, Ruby 3.3, bundler, rake, rubocop, solargraph."),
        ("dart", "Dart", "Base + Dart SDK, dart_style."),
        ("full", "Full", "Everything above in one image."),
        ("dind", "Docker-in-Docker", "Full + a Docker daemon for container builds."),
    ]
}

enum MoreWebhookEvents {
    static let groups: [(String, [String])] = [
        ("Tasks", ["task.completed", "task.failed", "task.needs_attention", "task.pr_opened", "review.completed"]),
        ("Workflow runs", ["workflow_run.queued", "workflow_run.started", "workflow_run.completed", "workflow_run.failed"]),
    ]
    static var all: [String] { groups.flatMap(\.1) }
}
