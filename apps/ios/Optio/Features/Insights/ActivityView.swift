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
                StatStrip(items: [
                    StatItem("Actions", model.stats.actions),
                    StatItem("Task events", model.stats.taskEvents),
                    StatItem("Auth", model.stats.authEvents),
                    StatItem("Infra", model.stats.infraEvents),
                ])
                .listRowInsets(EdgeInsets(top: Spacing.xs, leading: Spacing.l, bottom: Spacing.xs, trailing: Spacing.l))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)

                HStack {
                    Text("\(model.total) event\(model.total == 1 ? "" : "s") in the last \(model.days) day\(model.days == 1 ? "" : "s")")
                        .contentTransition(.numericText())
                    Spacer()
                    if model.liveConnected {
                        HStack(spacing: 4) { StateDot(tone: .working, size: 5); Text("live") }
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
                .listRowSeparator(.hidden)
            }

            if let error = model.error, model.items.isEmpty {
                if error.isForbidden { AdminOnlyState(what: "The activity feed").listRowSeparator(.hidden) } else {
                    ErrorRow(error: error, what: "activity") { Task { await model.load(api: api) } }
                }
            } else if model.items.isEmpty, model.loading {
                SkeletonRows()
            } else if model.items.isEmpty {
                EmptyState(title: "No activity", systemImage: "clock.arrow.circlepath", message: "Nothing matched these filters.")
                    .listRowSeparator(.hidden)
            } else {
                ForEach(groupedByDay, id: \.day) { group in
                    Section {
                        ForEach(group.items) { ActivityRow(item: $0) }
                    } header: {
                        SectionHeader(title: group.day).textCase(nil)
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
        .dimmedWhileLoading(model.loading && !model.items.isEmpty)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                PeriodPicker(days: Binding(get: { model.days }, set: { model.days = $0; model.offset = 0 }), options: [1, 7, 14, 30]).fixedSize()
                Menu {
                    Picker("Type", selection: Binding(get: { model.typeFilter }, set: { model.typeFilter = $0; model.offset = 0 })) {
                        ForEach(Self.typeOptions, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    Picker("Resource", selection: Binding(get: { model.resourceFilter }, set: { model.resourceFilter = $0; model.offset = 0 })) {
                        ForEach(Self.resourceOptions, id: \.0) { Text($0.1).tag($0.0) }
                    }
                } label: {
                    Image(systemName: model.typeFilter == nil && model.resourceFilter == nil ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
                }
            }
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
        var order: [String] = []
        var map: [String: [ActivityItem]] = [:]
        for item in model.items {
            let key = item.timestamp.isoDate.map { $0.dayHeader } ?? "Unknown date"
            if map[key] == nil { order.append(key) }
            map[key, default: []].append(item)
        }
        return order.map { ($0, map[$0] ?? []) }
    }
}

/// Dot row: `actor summary` · `2h · task 1a2b3c4d`, details behind a disclosure.
private struct ActivityRow: View {
    let item: ActivityItem
    @State private var expanded = false

    private var tone: Tone? {
        switch item.type {
        case "action": return .working
        case "infra_event": return .danger
        default: return nil
        }
    }

    private var typeLabel: String {
        switch item.type {
        case "action": return "action"
        case "task_event": return "task"
        case "auth_event": return "auth"
        case "infra_event": return "infra"
        default: return item.type
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(alignment: .top, spacing: Spacing.s) {
                if let tone { StateDot(tone: tone == .working && item.isLive ? .accent : tone).padding(.top, 7) }
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        if let name = item.actor?.displayName { Text(name).foregroundStyle(.primary) }
                        Text(item.summary).foregroundStyle(item.actor?.displayName == nil ? .primary : .secondary)
                    }
                    .font(.body)
                    .lineLimit(3)
                    Text.meta([
                        Text(item.timestamp.relativeDescription),
                        Text(typeLabel),
                        item.isLive ? Text("new") : nil,
                        (item.resourceId != nil && ["task", "workflow", "session"].contains(item.resourceType)) ? Text.mono("\(item.resourceType) \(item.resourceId!.prefix(8))") : nil,
                    ])?
                    .font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            if let details = item.details, !details.isEmpty {
                Button {
                    withAnimation(.snappy) { expanded.toggle() }
                } label: {
                    Label("Details", systemImage: expanded ? "chevron.down" : "chevron.right").font(.footnote)
                }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .padding(.leading, tone == nil ? 0 : 15)
                if expanded {
                    Text(Self.pretty(details))
                        .font(.monoCaption)
                        .foregroundStyle(.secondary)
                        .padding(Spacing.s)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.fill.tertiary, in: Radius.smallShape)
                }
            }
        }
        .padding(.vertical, Spacing.row)
    }

    private static func pretty(_ details: [String: AnyCodable]) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(details), let s = String(data: data, encoding: .utf8) { return s }
        return details.map { "\($0.key): \($0.value)" }.sorted().joined(separator: "\n")
    }
}
