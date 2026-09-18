import SwiftUI
import Observation

@Observable
@MainActor
final class WebhooksListModel {
    var webhooks: [WebhookRow] = []
    var loading = false
    var error: Error?

    func load(api: APIClient) async {
        loading = webhooks.isEmpty
        defer { loading = false }
        do {
            webhooks = try await api.listWebhooks()
            error = nil
        } catch {
            self.error = error
        }
    }
}

struct WebhooksListView: View {
    @Environment(APIClient.self) private var api
    @Environment(MoreContext.self) private var context
    @State private var model = WebhooksListModel()
    @State private var showNew = false
    @State private var pendingDelete: WebhookRow?
    @State private var notice: String?
    @State private var errorMessage: String?

    var body: some View {
        List {
            if model.loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if let error = model.error, model.webhooks.isEmpty {
                ErrorBanner(error: error) { Task { await model.load(api: api) } }
            } else if model.webhooks.isEmpty {
                EmptyState(title: "No webhooks", systemImage: "arrow.up.right.square",
                           message: "Subscribe to Optio events and get an HTTP POST when they fire.")
            } else {
                Section {
                    ForEach(model.webhooks) { wh in
                        NavigationLink {
                            WebhookDetailView(webhookId: wh.id) { await model.load(api: api) }
                        } label: {
                            row(wh)
                        }
                        .swipeActions(edge: .trailing) {
                            if context.isMember {
                                Button(role: .destructive) { pendingDelete = wh } label: { Label("Delete", systemImage: "trash") }
                                Button { Task { await test(wh) } } label: { Label("Test", systemImage: "paperplane") }
                                    .tint(AppTheme.accent)
                            }
                        }
                    }
                }
            }
            Section("Delivery details") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Each delivery POSTs JSON with X-Optio-Event and, when a secret is set, X-Optio-Signature (HMAC-SHA256).")
                    Text("Slack incoming webhook URLs are auto-detected and sent as formatted blocks.")
                    Text("Failed deliveries retry up to 3 times (5s, 10s, 20s) with a 10s timeout per attempt.")
                }
                .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Webhooks")
        .toolbar {
            if context.isMember {
                ToolbarItem(placement: .primaryAction) {
                    Button { showNew = true } label: { Image(systemName: "plus") }
                }
            }
        }
        .task { await model.load(api: api) }
        .refreshable { await model.load(api: api) }
        .sheet(isPresented: $showNew) {
            NewWebhookSheet { await model.load(api: api) }
        }
        .confirmationDialog("Delete this webhook?", isPresented: Binding(
            get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }
        ), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                guard let wh = pendingDelete else { return }
                Task {
                    do { try await api.deleteWebhook(wh.id); await model.load(api: api) }
                    catch { errorMessage = error.moreDescription }
                }
            }
        } message: { Text("Delivery history will be lost.") }
        .alert("Test delivery", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK") { notice = nil }
        } message: { Text(notice ?? "") }
        .moreErrorAlert($errorMessage)
    }

    private func row(_ wh: WebhookRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Circle().fill(wh.active == false ? Color.gray : Color.green).frame(width: 8, height: 8)
                Text(wh.url ?? wh.id).font(.subheadline.monospaced()).lineLimit(1)
            }
            if let d = wh.description, !d.isEmpty {
                Text(d).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
            HStack {
                let events = wh.events ?? []
                Text(events.prefix(3).joined(separator: ", ") + (events.count > 3 ? " +\(events.count - 3)" : ""))
                    .font(.caption2.monospaced()).foregroundStyle(.tertiary).lineLimit(1)
                Spacer()
                if let c = wh.createdAt { Text(c.relativeDescription).font(.caption2).foregroundStyle(.tertiary) }
            }
        }
        .padding(.vertical, 2)
    }

    private func test(_ wh: WebhookRow) async {
        do {
            let d = try await api.testWebhook(wh.id, event: nil)
            notice = d.success == true
                ? "Delivered (HTTP \(d.statusCode.map(String.init) ?? "?"))"
                : "Failed: \(d.error ?? "HTTP \(d.statusCode.map(String.init) ?? "?")")"
        } catch {
            errorMessage = error.moreDescription
        }
    }
}

struct NewWebhookSheet: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    var onCreated: () async -> Void

    @State private var url = ""
    @State private var description = ""
    @State private var secret = ""
    @State private var events: Set<String> = ["workflow_run.completed"]
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://example.com/webhook", text: $url)
                        .keyboardType(.URL).autocorrectionDisabled().textInputAutocapitalization(.never)
                    TextField("Description (optional)", text: $description)
                    SecureField("Secret (optional, HMAC-SHA256)", text: $secret)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                } footer: {
                    Text("Must be a public HTTPS URL — private/internal addresses are blocked. When a secret is set, deliveries include an X-Optio-Signature header.")
                }
                ForEach(MoreWebhookEvents.groups, id: \.0) { group in
                    Section(group.0) {
                        ForEach(group.1, id: \.self) { ev in
                            Toggle(isOn: Binding(
                                get: { events.contains(ev) },
                                set: { on in if on { events.insert(ev) } else { events.remove(ev) } }
                            )) {
                                Text(ev).font(.footnote.monospaced())
                            }
                        }
                    }
                }
            }
            .navigationTitle("New Webhook")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        if saving { ProgressView() } else { Text("Create") }
                    }
                    .disabled(saving || url.trimmingCharacters(in: .whitespaces).isEmpty || events.isEmpty)
                }
            }
            .moreErrorAlert($errorMessage)
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            _ = try await api.createWebhook(WebhookCreateInput(
                url: url.trimmingCharacters(in: .whitespaces),
                events: MoreWebhookEvents.all.filter { events.contains($0) },
                secret: secret.isEmpty ? nil : secret,
                description: description.isEmpty ? nil : description
            ))
            secret = ""
            await onCreated()
            dismiss()
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
