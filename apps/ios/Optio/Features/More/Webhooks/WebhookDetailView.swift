import SwiftUI
import Observation

@Observable
@MainActor
final class WebhookDetailModel {
    let webhookId: String
    var webhook: WebhookRow?
    var deliveries: [WebhookDeliveryRow] = []
    var error: Error?

    init(webhookId: String) { self.webhookId = webhookId }

    func load(api: APIClient) async {
        do {
            async let wh = api.getWebhook(webhookId)
            async let del = api.listWebhookDeliveries(webhookId, limit: 50)
            webhook = try await wh
            deliveries = (try? await del) ?? []
            error = nil
        } catch {
            self.error = error
        }
    }

    var successRate: Int? {
        guard !deliveries.isEmpty else { return nil }
        let ok = deliveries.filter { $0.success == true }.count
        return Int((Double(ok) / Double(deliveries.count) * 100).rounded())
    }
}

struct WebhookDetailView: View {
    @Environment(APIClient.self) private var api
    @Environment(MoreContext.self) private var context
    @Environment(\.dismiss) private var dismiss
    @State private var model: WebhookDetailModel
    var onChanged: () async -> Void

    @State private var testEvent = ""
    @State private var busy = false
    @State private var showDeleteConfirm = false
    @State private var expanded: Set<String> = []
    @State private var notice: String?
    @State private var errorMessage: String?

    init(webhookId: String, onChanged: @escaping () async -> Void) {
        _model = State(initialValue: WebhookDetailModel(webhookId: webhookId))
        self.onChanged = onChanged
    }

    var body: some View {
        Group {
            if let wh = model.webhook {
                content(wh)
            } else if let error = model.error {
                ErrorBanner(error: error) { Task { await model.load(api: api) } }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(model.webhook?.description ?? "Webhook")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load(api: api) }
        .refreshable { await model.load(api: api) }
        .alert("Test delivery", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK") { notice = nil }
        } message: { Text(notice ?? "") }
        .moreErrorAlert($errorMessage)
    }

    private func content(_ wh: WebhookRow) -> some View {
        List {
            Section {
                HStack(alignment: .top) {
                    Circle().fill(wh.active == false ? Color.gray : Color.green).frame(width: 8, height: 8).padding(.top, 6)
                    Text(wh.url ?? "").font(.footnote.monospaced()).textSelection(.enabled)
                }
                if let c = wh.createdAt { MoreInfoRow(label: "Created", value: c.relativeDescription) }
                MoreInfoRow(label: "Signing", value: (wh.secret ?? "").isEmpty ? "None" : "HMAC-SHA256")
                MoreInfoRow(label: "Status", value: wh.active == false ? "Disabled" : "Active")
            }

            Section("Subscribed events") {
                MoreChipCloud(items: wh.events ?? [])
            }

            if context.isMember {
                Section {
                    Picker("Event", selection: $testEvent) {
                        Text("Default (\(wh.events?.first ?? "—"))").tag("")
                        ForEach(MoreWebhookEvents.all, id: \.self) { Text($0).tag($0) }
                    }
                    Button { Task { await test() } } label: {
                        if busy { ProgressView() } else { Label("Send test delivery", systemImage: "paperplane") }
                    }
                    .disabled(busy)
                } header: {
                    Text("Test")
                } footer: {
                    Text("Delivers a synthetic sample payload to verify the receiver is reachable.")
                }

                Section {
                    Button {
                        Task { await toggle(wh) }
                    } label: {
                        Label(wh.active == false ? "Enable" : "Disable", systemImage: wh.active == false ? "play" : "pause")
                    }
                    .disabled(busy)
                    Button(role: .destructive) { showDeleteConfirm = true } label: {
                        Label("Delete webhook", systemImage: "trash")
                    }
                    .disabled(busy)
                }
            }

            Section {
                if model.deliveries.isEmpty {
                    Text("No deliveries yet. Fire a test or trigger a subscribed event.")
                        .font(.footnote).foregroundStyle(.secondary)
                } else {
                    ForEach(model.deliveries) { d in
                        deliveryRow(d)
                    }
                }
            } header: {
                HStack {
                    Text("Delivery history")
                    Spacer()
                    if let rate = model.successRate {
                        Text("\(model.deliveries.count) · \(rate)% ok").textCase(nil)
                    }
                }
            }
        }
        .confirmationDialog("Delete this webhook and all delivery history?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await deleteHook() } }
        }
    }

    private func deliveryRow(_ d: WebhookDeliveryRow) -> some View {
        DisclosureGroup(isExpanded: Binding(
            get: { expanded.contains(d.id) },
            set: { on in if on { expanded.insert(d.id) } else { expanded.remove(d.id) } }
        )) {
            VStack(alignment: .leading, spacing: 8) {
                if let payload = d.payload {
                    Text("Payload").font(.caption).foregroundStyle(.secondary)
                    MoreCodeBlock(text: prettyJSON(payload))
                }
                if let body = d.responseBody, !body.isEmpty {
                    Text("Response body").font(.caption).foregroundStyle(.secondary)
                    MoreCodeBlock(text: body, lineLimit: 30)
                }
                if let err = d.error {
                    Text(err).font(.caption).foregroundStyle(.red)
                }
            }
            .padding(.vertical, 4)
        } label: {
            HStack(spacing: 8) {
                StatusBadge(text: d.success == true ? "ok" : "fail", color: d.success == true ? .green : .red)
                VStack(alignment: .leading, spacing: 2) {
                    Text(d.event ?? "").font(.caption.monospaced())
                    HStack(spacing: 8) {
                        if let code = d.statusCode { Text("HTTP \(code)") }
                        Text("attempt \(d.attempt ?? 1)")
                        if let at = d.deliveredAt { Text(at.relativeDescription) }
                    }
                    .font(.caption2).foregroundStyle(.tertiary)
                }
                Spacer()
                if let err = d.error, !err.isEmpty {
                    Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
                }
            }
        }
    }

    private func prettyJSON(_ value: AnyCodable) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let obj = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
              let s = String(data: pretty, encoding: .utf8) else { return value.description }
        return s
    }

    private func test() async {
        busy = true
        defer { busy = false }
        do {
            let d = try await api.testWebhook(model.webhookId, event: testEvent.isEmpty ? nil : testEvent)
            notice = d.success == true
                ? "Delivered (HTTP \(d.statusCode.map(String.init) ?? "?"))"
                : "Failed: \(d.error ?? "HTTP \(d.statusCode.map(String.init) ?? "?")")"
            await model.load(api: api)
        } catch {
            errorMessage = error.moreDescription
        }
    }

    private func toggle(_ wh: WebhookRow) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await api.updateWebhook(wh.id, WebhookUpdateInput(active: !(wh.active ?? true)))
            await model.load(api: api)
            await onChanged()
        } catch {
            errorMessage = error.moreDescription
        }
    }

    private func deleteHook() async {
        busy = true
        defer { busy = false }
        do {
            try await api.deleteWebhook(model.webhookId)
            await onChanged()
            dismiss()
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
