import SwiftUI

/// Shown once, right after a Pylon / Alertmanager / Datadog trigger is created:
/// the URL the provider posts to, the header, and the secret — which no later
/// read returns (web `TriggerSecretDialog`). Done moves on to the work.
struct TriggerSecretSheet: View {
    let secret: WorkForm.MintedSecret
    let baseURL: URL?
    let onDone: () -> Void

    /// `{origin}/api/hooks/<type>/<trigger id>` — the server's origin, as the app reaches it.
    var url: String {
        let origin = baseURL?.absoluteString.replacing(/\/+$/, with: "") ?? ""
        return "\(origin)/api/hooks/\(secret.type.rawValue)/\(secret.triggerId)"
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(copy.where)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Section {
                    CopyRow(label: "URL", value: url)
                    CopyRow(label: "Header", value: "X-Optio-Secret", hint: copy.headerHint)
                    CopyRow(label: "Secret", value: secret.secret)
                } footer: {
                    Text("Copy the secret now — it isn't shown again. A new one can be minted from the work's page on the web.")
                }
            }
            .navigationTitle(copy.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done", action: onDone) }
            }
        }
        .interactiveDismissDisabled()
    }

    private struct Copy {
        let title: String
        let `where`: String
        var headerHint: String? = nil
    }

    /// What the sheet says per provider (web `SECRET_COPY`).
    private var copy: Copy {
        switch secret.type {
        case .alertmanager:
            return Copy(
                title: "Alertmanager is listening",
                where: "In Alertmanager, add a webhook_config with this URL and `authorization: credentials: <secret>` (or basic auth with any user and the secret as the password). In Grafana, a Webhook contact point with the Authorization header `Bearer <secret>`.",
                headerHint: "or Authorization: Bearer <secret>"
            )
        case .datadog:
            return Copy(
                title: "Datadog is listening",
                where: "In Datadog → Integrations → Webhooks, add a webhook with this URL, a custom header carrying the secret, and the payload template from the trigger's page on the web; then @webhook-<name> in the monitor's message."
            )
        default:
            return Copy(
                title: "\(secret.type.rawValue.capitalized) is listening",
                where: "In Pylon → Settings → Triggers, add a webhook action with this URL and header."
            )
        }
    }
}

/// A value with a copy button; the whole row copies.
private struct CopyRow: View {
    let label: String
    let value: String
    var hint: String? = nil
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = value
            copied = true
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        } label: {
            HStack(alignment: .top, spacing: Spacing.m) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(.footnote).foregroundStyle(.secondary)
                    Text(value).font(.monoSubheadline).foregroundStyle(.primary).lineLimit(4)
                    if let hint { Text(hint).font(.footnote).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 0)
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .foregroundStyle(copied ? StatusColor.green : AppTheme.accent)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Copy \(label.lowercased())")
        .accessibilityValue(value)
    }
}
