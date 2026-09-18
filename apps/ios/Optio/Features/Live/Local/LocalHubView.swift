import SwiftUI

/// Navigation targets pushed from the Local hub. Declared here so the hub can
/// register one `navigationDestination` for everything under it.
enum LocalRoute: Hashable {
    case terminal(id: String)
    case blueprints
    case blueprint(id: String)
}

/// The `/local` screen: stat strip (tappable filters), host chips, the
/// "Needs you" queue, and the terminal list. Lives inside the Live tab's
/// `NavigationStack` — it sets no title of its own.
struct LocalHubView: View {
    @Environment(APIClient.self) private var api
    @State private var model: LocalHubModel?
    @State private var showNew = false
    @State private var pendingKill: LocalTerminal?
    @State private var pendingDelete: LocalTerminal?
    @State private var pushAfterCreate: String?

    var body: some View {
        Group {
            if let model {
                content(model)
            } else {
                List { SkeletonStrip(labels: ["Needs you", "Working", "Idle", "Finished"]).listRowSeparator(.hidden).listRowBackground(Color.clear); SkeletonRows() }.listStyle(.plain)
            }
        }
        .navigationDestination(for: LocalRoute.self) { route in
            switch route {
            case .terminal(let id):
                LocalTerminalScreen(terminalId: id, hosts: model?.hosts ?? [])
            case .blueprints:
                LocalBlueprintsView(hosts: model?.hosts ?? [])
            case .blueprint(let id):
                LocalBlueprintDetailView(blueprintId: id, hosts: model?.hosts ?? [])
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showNew = true } label: { Image(systemName: "plus") }
                    .disabled(model?.hosts.isEmpty ?? true)
                    .accessibilityLabel("New terminal")
            }
            ToolbarItem(placement: .secondaryAction) {
                NavigationLink(value: LocalRoute.blueprints) {
                    Label("Blueprints", systemImage: "square.stack.3d.up")
                }
            }
        }
        .task {
            if model == nil { model = LocalHubModel(api: api) }
            guard let model else { return }
            await model.refresh()
            model.start()
        }
        .onDisappear { model?.stop() }
        .onAppear { model?.start() }
        .sheet(isPresented: $showNew) {
            if let model {
                NewTerminalSheet(hosts: model.hosts) { created in
                    model.replace(created)
                    pushAfterCreate = created.id
                }
            }
        }
        .navigationDestination(isPresented: Binding(get: { pushAfterCreate != nil }, set: { if !$0 { pushAfterCreate = nil } })) {
            if let id = pushAfterCreate {
                LocalTerminalScreen(terminalId: id, hosts: model?.hosts ?? [])
            }
        }
        .confirmationDialog("Kill this terminal's process?", isPresented: Binding(get: { pendingKill != nil }, set: { if !$0 { pendingKill = nil } }), titleVisibility: .visible) {
            Button("Kill", role: .destructive) {
                if let t = pendingKill, let model { Task { await model.kill(t) } }
                pendingKill = nil
            }
        }
        .confirmationDialog("Delete terminal “\(pendingDelete?.title ?? "")”?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let t = pendingDelete, let model { Task { await model.delete(t) } }
                pendingDelete = nil
            }
        } message: {
            Text("Removes the record. The scrollback is not kept.")
        }
        .errorToast(Binding(get: { model?.actionError }, set: { model?.actionError = $0 }))
    }

    @ViewBuilder
    private func content(_ model: LocalHubModel) -> some View {
        @Bindable var model = model
        if !model.loaded {
            List { SkeletonStrip(labels: ["Needs you", "Working", "Idle", "Finished"]).listRowSeparator(.hidden).listRowBackground(Color.clear); SkeletonRows() }.listStyle(.plain)
        } else if let error = model.error, model.hosts.isEmpty {
            List { ErrorRow(error: error, what: "local terminals") { Task { await model.refresh() } } }
                .listStyle(.plain)
                .refreshable { await model.refresh() }
        } else if model.hosts.isEmpty {
            noHosts
                .refreshable { await model.refresh() }
        } else {
            List {
                Section {
                    statsBar(model)
                        .listRowInsets(EdgeInsets(top: Spacing.xs, leading: Spacing.l, bottom: Spacing.xs, trailing: Spacing.l))
                        .listRowBackground(Color.clear)
                    hostsStrip(model)
                        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: Spacing.xs, trailing: 0))
                        .listRowBackground(Color.clear)
                }
                .listRowSeparator(.hidden)

                if let error = model.error {
                    ErrorRow(error: error, what: "local terminals") { Task { await model.refresh() } }
                }

                if !model.needsYou.isEmpty, model.filter == .all, model.search.isEmpty {
                    Section {
                        ForEach(model.needsYou.prefix(3), id: \.id) { t in
                            NavigationLink(value: LocalRoute.terminal(id: t.id)) {
                                TerminalRowView(terminal: t, hostName: model.hosts.count > 1 ? model.hostById[t.hostId]?.name : nil)
                            }
                        }
                    } header: {
                        SectionHeader(title: "Needs you", detail: model.needsYou.count > 3 ? "\(model.needsYou.count)" : nil, tone: .accent) {
                            withAnimation(.snappy) { model.filter = .needsYou }
                        }
                        .textCase(nil)
                    }
                }

                Section {
                    ChipPicker(options: [
                        (LocalHubModel.Filter.all, "All"),
                        (.active, "Active"),
                        (.needsYou, "Needs you"),
                        (.exited, "Finished"),
                    ], selection: $model.filter)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)

                    if model.filtered.isEmpty {
                        EmptyState(
                            title: model.terminals.isEmpty ? "No terminals yet" : emptyTitle(model.filter),
                            systemImage: "terminal",
                            message: model.terminals.isEmpty
                                ? "Spawn a terminal on one of your paired machines."
                                : "Nothing matches this filter.",
                            actionTitle: model.terminals.isEmpty ? "New terminal" : nil,
                            action: { showNew = true }
                        )
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    } else {
                        ForEach(model.filtered, id: \.id) { t in
                            NavigationLink(value: LocalRoute.terminal(id: t.id)) {
                                TerminalRowView(terminal: t, hostName: model.hosts.count > 1 ? model.hostById[t.hostId]?.name : nil)
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                if LocalPresentation.canDelete(t) {
                                    Button(role: .destructive) { pendingDelete = t } label: { Label("Delete", systemImage: "trash") }
                                }
                                if LocalPresentation.canKill(t) {
                                    Button { pendingKill = t } label: { Label("Kill", systemImage: "xmark.circle") }.tint(.red)
                                }
                            }
                            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                if LocalPresentation.canStart(t) {
                                    Button { Task { await model.start(t) } } label: { Label("Start", systemImage: "play.fill") }.tint(AppTheme.accent)
                                }
                            }
                            .contextMenu {
                                if LocalPresentation.canStart(t) {
                                    Button { Task { await model.start(t) } } label: { Label("Start", systemImage: "play.fill") }
                                }
                                if LocalPresentation.canKill(t) {
                                    Button(role: .destructive) { pendingKill = t } label: { Label("Kill", systemImage: "xmark.circle") }
                                }
                                if LocalPresentation.canDelete(t) {
                                    Button(role: .destructive) { pendingDelete = t } label: { Label("Delete", systemImage: "trash") }
                                }
                            }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .animation(.snappy, value: model.filter)
            .searchable(text: $model.search, prompt: "Search")
            .refreshable { await model.refresh() }
        }
    }

    private func emptyTitle(_ f: LocalHubModel.Filter) -> String {
        switch f {
        case .all: return "Nothing matches"
        case .active: return "Nothing running"
        case .needsYou: return "Nothing needs you"
        case .exited: return "Nothing finished"
        }
    }

    private var noHosts: some View {
        List {
            EmptyState(title: "No machines paired", systemImage: "laptopcomputer.and.iphone",
                       message: "On your machine, run `optio login`, then `optio local add <dir>` for each directory to expose, and `optio local up` to connect. Your host will appear here.")
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
        }
        .listStyle(.plain)
    }

    private func statsBar(_ model: LocalHubModel) -> some View {
        @Bindable var model = model
        let s = model.stats
        let selectedKey: String? = switch model.filter {
        case .needsYou: "needsYou"
        case .active: "active"
        case .exited: "exited"
        case .all: nil
        }
        return StatStrip(items: [
            StatItem("Needs you", s.needsYou, tone: .accent, key: "needsYou"),
            StatItem("Working", s.working, key: "active"),
            StatItem("Idle", s.idle, key: "idle"),
            StatItem("Finished", s.finished, key: "exited"),
        ], selected: selectedKey) { item in
            let target: LocalHubModel.Filter? = switch item.key {
            case "needsYou": .needsYou
            case "active": .active
            case "exited": .exited
            default: nil
            }
            guard let target else { return }
            withAnimation(.snappy) { model.filter = model.filter == target ? .all : target }
        }
    }

    private func hostsStrip(_ model: LocalHubModel) -> some View {
        @Bindable var model = model
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Spacing.s) {
                ForEach(model.hosts, id: \.id) { h in
                    let selected = model.hostFilter == h.id
                    Button {
                        if model.hosts.count > 1 { withAnimation(.snappy) { model.hostFilter = selected ? nil : h.id } }
                    } label: {
                        HStack(spacing: 6) {
                            Circle().fill(h.state == .online ? Tone.success.color : Tone.idle.color).frame(width: 6, height: 6)
                            Text(h.name).font(.caption.weight(.medium))
                            Text(h.state == .online ? "\(h.dirs.count) dir\(h.dirs.count == 1 ? "" : "s")" : "offline").font(.caption2).opacity(0.6)
                        }
                        .foregroundStyle(selected ? Color(.systemBackground) : Color.primary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(selected ? AnyShapeStyle(Color.primary) : AnyShapeStyle(.fill.tertiary), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Text("\(h.hostname) · \(h.platform)\(h.arch.map { " · \($0)" } ?? "")")
                        if let v = h.daemonVersion { Text("daemon \(v)") }
                        if let seen = h.lastSeenAt { Text("seen \(seen.relativeDescription)") }
                        ForEach(h.dirs, id: \.path) { d in Text(d.path) }
                    }
                }
            }
            .padding(.horizontal, Spacing.l)
        }
    }
}

/// One terminal row: state dot, title, `host · dir · command`, trailing
/// activity time or attention reason (`terminal-row.tsx`).
struct TerminalRowView: View {
    let terminal: LocalTerminal
    var hostName: String?

    private var needsYou: Bool { LocalPresentation.waitsOnYou(terminal) }

    private var trailing: (String, Tone?) {
        if needsYou { return (LocalPresentation.waitingLabel(terminal), .accent) }
        if terminal.state == .error { return ("Error", .danger) }
        if terminal.state == .exited, let code = terminal.exitCode, code != 0 { return ("exit \(Int(code))", .danger) }
        if terminal.state == .exited { return ("Finished", nil) }
        if terminal.state == .pending { return (terminal.pendingReason == .hostOffline ? "Host offline" : "Held", nil) }
        return (LocalPresentation.activityDescription(terminal), nil)
    }

    private var meta: Text? {
        var parts: [Text?] = []
        if let hostName { parts.append(Text(hostName)) }
        parts.append(Text.mono(LocalPresentation.dirTail(terminal.dir)))
        if let command = terminal.command, !command.isEmpty { parts.append(Text.mono(command)) }
        else if !specLabel.isEmpty { parts.append(Text(specLabel)) }
        return Text.meta(parts)
    }

    private var footer: Text? {
        if LocalPresentation.isDead(terminal), let msg = terminal.errorMessage, !msg.isEmpty { return Text(msg) }
        let links = LocalPresentation.workLinks(terminal)
        if !links.isEmpty { return Text(links.prefix(3).map(WorkLinkBadges.shortLabel).joined(separator: " · ")).font(.monoFootnote) }
        return nil
    }

    var body: some View {
        OptioRow(
            title: terminal.title,
            tone: LocalPresentation.rowTone(terminal),
            meta: meta,
            trailing: trailing.0,
            trailingTone: trailing.1,
            footer: footer,
            titleLineLimit: 1
        )
    }

    private var specLabel: String {
        switch terminal.spec {
        case .shell: return "shell"
        case .command(let p): return p.command
        case .agent(let p): return LocalPresentation.agentLabel(p.agent)
        case .unknown: return ""
        }
    }
}
