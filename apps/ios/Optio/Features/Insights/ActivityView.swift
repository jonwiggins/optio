import Foundation
import SwiftUI

@Observable
@MainActor
final class ActivityModel {
    static let limit = 50

    var days = 7
    var typeFilter: String? = nil
    var resourceFilter: String? = nil
    var offset = 0
    var items: [ActivityItem] = []
    var total = 0
    var stats = ActivityStats()
    var loading = false
    var error: Error?
    var liveConnected = false

    private var ws: WebSocketClient?
    private var liveTask: Task<Void, Never>?
    private var reconcileTask: Task<Void, Never>?

    var filterKey: String { "\(days)|\(typeFilter ?? "")|\(resourceFilter ?? "")|\(offset)" }

    func load(api: APIClient) async {
        loading = true
        defer { loading = false }
        do {
            let feed = try await api.activityFeed(days: days, type: typeFilter, resourceType: resourceFilter, limit: Self.limit, offset: offset)
            items = feed.items
            total = feed.total
            stats = feed.stats ?? ActivityStats()
            error = nil
        } catch {
            self.error = error
        }
    }

    /// Subscribes to `/ws/events` and prepends `activity:new` frames to the feed
    /// (only on the first page with no type/resource filter excluding them), then
    /// re-fetches shortly after so the synthesized row is replaced by the real one.
    func startLive(api: APIClient) {
        guard ws == nil else { return }
        let client = WebSocketClient(api: api, path: "/ws/events")
        ws = client
        client.connect()
        liveTask = Task { [weak self] in
            for await frame in client.frames {
                guard let self else { return }
                switch frame {
                case .opened: self.liveConnected = true
                case .closed: self.liveConnected = false
                case .json(let obj):
                    guard obj["type"] as? String == "activity:new",
                          let data = try? JSONSerialization.data(withJSONObject: obj),
                          let ev = try? api.decoder.decode(ActivityNewEvent.self, from: data) else { continue }
                    self.prepend(ev, api: api)
                default: break
                }
            }
        }
    }

    func stopLive() {
        liveTask?.cancel(); liveTask = nil
        reconcileTask?.cancel(); reconcileTask = nil
        ws?.disconnect(); ws = nil
        liveConnected = false
    }

    private func prepend(_ ev: ActivityNewEvent, api: APIClient) {
        // `activity:new` is only published for user actions (optio-action-service).
        guard offset == 0, typeFilter == nil || typeFilter == "action" else { return }
        if let rf = resourceFilter, rf != ev.resourceType { return }
        let item = ActivityItem(
            id: "live-\(UUID().uuidString)",
            type: "action",
            timestamp: ev.timestamp,
            actor: nil,
            action: ev.action,
            resourceType: ev.resourceType ?? ev.action.split(separator: ".").first.map(String.init) ?? "",
            resourceId: ev.resourceId,
            summary: ev.summary,
            details: nil,
            isLive: true
        )
        items.insert(item, at: 0)
        total += 1
        stats.actions += 1
        reconcileTask?.cancel()
        reconcileTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let self else { return }
            await self.load(api: api)
        }
    }
}

/// Mirrors `apps/web/src/app/activity/page.tsx`.
struct ActivityView: View {
    @Environment(APIClient.self) private var api
    @State private var model = ActivityModel()

    private static let typeOptions: [(String?, String)] = [
        (nil, "All types"), ("action", "User actions"), ("task_event", "Task events"), ("auth_event", "Auth events"), ("infra_event", "Infra events"),
    ]
    private static let resourceOptions: [(String?, String)] = [
        (nil, "All resources"), ("task", "Tasks"), ("repo", "Repos"), ("workflow", "Workflows"), ("connection", "Connections"),
        ("secret", "Secrets"), ("webhook", "Webhooks"), ("session", "Sessions"),
    ]
    private static let dayOptions: [(Int, String)] = [(1, "Today"), (7, "7 days"), (14, "14 days"), (30, "30 days")]

    var body: some View {
        List {
            Section {
                HStack(spacing: 8) {
                    filterMenu(Self.typeOptions, selection: model.typeFilter, icon: "tag") { model.typeFilter = $0; model.offset = 0 }
                    filterMenu(Self.resourceOptions, selection: model.resourceFilter, icon: "shippingbox") { model.resourceFilter = $0; model.offset = 0 }
                    Menu {
                        ForEach(Self.dayOptions, id: \.0) { d in Button(d.1) { model.days = d.0; model.offset = 0 } }
                    } label: {
                        Label(Self.dayOptions.first { $0.0 == model.days }?.1 ?? "\(model.days) days", systemImage: "calendar").font(.caption)
                    }
                }
                .listRowSeparator(.hidden)

                HStack {
                    Text("\(model.total) event\(model.total == 1 ? "" : "s") in the last \(model.days) day\(model.days == 1 ? "" : "s")")
                    Spacer()
                    if model.liveConnected {
                        Label("live", systemImage: "dot.radiowaves.left.and.right").foregroundStyle(.green)
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
                .listRowSeparator(.hidden)

                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    StatTile(title: "User actions", value: "\(model.stats.actions)", color: AppTheme.accent)
                    StatTile(title: "Task events", value: "\(model.stats.taskEvents)", color: .blue)
                    StatTile(title: "Auth events", value: "\(model.stats.authEvents)", color: .yellow)
                    StatTile(title: "Infra events", value: "\(model.stats.infraEvents)", color: .red)
                }
                .listRowSeparator(.hidden)
            }

            if let error = model.error, model.items.isEmpty {
                if error.isForbidden { AdminOnlyState(what: "The activity feed") } else {
                    ErrorBanner(error: error) { Task { await model.load(api: api) } }
                }
            } else if model.items.isEmpty, !model.loading {
                EmptyState(title: "No activity", systemImage: "waveform.path.ecg", message: "Nothing matched the selected filters.")
            } else {
                ForEach(groupedByDay, id: \.day) { group in
                    Section(group.day) {
                        ForEach(group.items) { ActivityRow(item: $0) }
                    }
                }
                if model.offset > 0 || model.offset + ActivityModel.limit < model.total {
                    Section {
                        HStack {
                            Button("Previous") { model.offset = max(0, model.offset - ActivityModel.limit) }
                                .disabled(model.offset == 0)
                            Spacer()
                            Text("\(model.offset + 1)–\(min(model.offset + ActivityModel.limit, model.total)) of \(model.total)")
                                .font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button("Next") { model.offset += ActivityModel.limit }
                                .disabled(model.offset + ActivityModel.limit >= model.total)
                        }
                        .font(.subheadline)
                    }
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if model.loading, model.items.isEmpty { ProgressView() }
        }
        .refreshable { await model.load(api: api) }
        .task(id: model.filterKey) { await model.load(api: api) }
        .onAppear { model.startLive(api: api) }
        .onDisappear { model.stopLive() }
    }

    private func filterMenu(_ options: [(String?, String)], selection: String?, icon: String, pick: @escaping (String?) -> Void) -> some View {
        Menu {
            ForEach(Array(options.enumerated()), id: \.offset) { _, o in Button(o.1) { pick(o.0) } }
        } label: {
            Label(options.first { $0.0 == selection }?.1 ?? "All", systemImage: icon).font(.caption).lineLimit(1)
        }
    }

    private var groupedByDay: [(day: String, items: [ActivityItem])] {
        let f = DateFormatter()
        f.dateStyle = .full
        f.timeStyle = .none
        var order: [String] = []
        var map: [String: [ActivityItem]] = [:]
        for item in model.items {
            let key = item.timestamp.isoDate.map { f.string(from: $0) } ?? "Unknown date"
            if map[key] == nil { order.append(key) }
            map[key, default: []].append(item)
        }
        return order.map { ($0, map[$0] ?? []) }
    }
}

private struct ActivityRow: View {
    let item: ActivityItem
    @State private var expanded = false

    private var typeColor: Color {
        switch item.type {
        case "action": return AppTheme.accent
        case "task_event": return .blue
        case "auth_event": return .yellow
        case "infra_event": return .red
        default: return .secondary
        }
    }

    private var icon: String {
        switch item.resourceType {
        case "task": return "list.bullet.rectangle"
        case "repo": return "folder"
        case "workflow", "workflow_run", "workflow_trigger": return "arrow.triangle.branch"
        case "connection", "connection_provider", "connection_assignment": return "powerplug"
        case "secret": return "key"
        case "webhook": return "link"
        case "session": return "terminal"
        case "settings", "mcp_server": return "gearshape"
        case "auth": return "shield"
        case "pod": return "server.rack"
        case "review": return "bolt"
        default: return "waveform.path.ecg"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.caption)
                .frame(width: 30, height: 30)
                .background(typeColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                .foregroundStyle(typeColor)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    if let name = item.actor?.displayName { Text(name).fontWeight(.medium) }
                    Text(item.summary).foregroundStyle(.secondary)
                }
                .font(.subheadline)
                HStack(spacing: 6) {
                    Text(item.timestamp.relativeDescription)
                    Text("·").opacity(0.4)
                    StatusBadge(text: item.type, color: typeColor)
                    if item.isLive { StatusBadge(text: "new", color: .green) }
                    if let rid = item.resourceId, ["task", "workflow", "session"].contains(item.resourceType) {
                        Text("·").opacity(0.4)
                        Text("\(item.resourceType) \(rid.prefix(8))").font(.caption2.monospaced())
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
                if let details = item.details, !details.isEmpty {
                    Button {
                        withAnimation { expanded.toggle() }
                    } label: {
                        Label("Details", systemImage: expanded ? "chevron.down" : "chevron.right").font(.caption)
                    }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    if expanded {
                        Text(Self.pretty(details))
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 6))
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    private static func pretty(_ details: [String: AnyCodable]) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(details), let s = String(data: data, encoding: .utf8) { return s }
        return details.map { "\($0.key): \($0.value)" }.sorted().joined(separator: "\n")
    }
}
