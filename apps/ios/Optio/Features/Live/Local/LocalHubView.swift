import SwiftUI

/// Navigation targets pushed from the Local hub. Declared here so the hub can
/// register one `navigationDestination` for everything under it.
enum LocalRoute: Hashable {
    case terminal(id: String)
    case blueprints
    case blueprint(id: String)
}

/// The `/local` screen: headline stats, hosts strip, the "needs you" queue,
/// and the terminal list. Expects to live inside a `NavigationStack`
/// (the Live tab's), pushing `LocalRoute`s for terminals and blueprints.
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
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle("Local")
        .navigationBarTitleDisplayMode(.large)
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
                Menu {
                    Button { showNew = true } label: { Label("New Terminal", systemImage: "plus") }
                        .disabled(model?.hosts.isEmpty ?? true)
                    NavigationLink(value: LocalRoute.blueprints) {
                        Label("Blueprints", systemImage: "square.stack.3d.up")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
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
        .confirmationDialog("Delete terminal \"\(pendingDelete?.title ?? "")\"?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let t = pendingDelete, let model { Task { await model.delete(t) } }
                pendingDelete = nil
            }
        } message: {
            Text("Removes the record. The scrollback is not kept.")
        }
        .alert("Action failed", isPresented: Binding(get: { model?.actionError != nil }, set: { if !$0 { model?.actionError = nil } })) {
            Button("OK") { model?.actionError = nil }
        } message: {
            Text(model?.actionError ?? "")
        }
    }

    @ViewBuilder
    private func content(_ model: LocalHubModel) -> some View {
        @Bindable var model = model
        if !model.loaded {
            ProgressView("Loading local terminals…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = model.error, model.hosts.isEmpty {
            ErrorBanner(error: error) { Task { await model.refresh() } }
        } else if model.hosts.isEmpty {
            noHosts
                .refreshable { await model.refresh() }
        } else {
            List {
                Section {
                    statsBar(model)
                        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                        .listRowBackground(Color.clear)
                    hostsStrip(model)
                        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 4, trailing: 0))
                        .listRowBackground(Color.clear)
                }
                .listRowSeparator(.hidden)

                if !model.needsYou.isEmpty, model.filter == .all {
                    Section {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(model.needsYou, id: \.id) { t in
                                    NavigationLink(value: LocalRoute.terminal(id: t.id)) {
                                        NeedsYouCard(terminal: t)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal)
                        }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    } header: {
                        Text("Needs you").foregroundStyle(.yellow)
                    }
                    .listRowSeparator(.hidden)
                }

                Section {
                    ChipPicker(options: [
                        (LocalHubModel.Filter.all, "All"),
                        (.active, "Active"),
                        (.needsYou, "Needs you"),
                        (.exited, "Exited"),
                    ], selection: $model.filter)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)

                    if model.filtered.isEmpty {
                        EmptyState(
                            title: model.terminals.isEmpty ? "No terminals yet" : "Nothing matches",
                            systemImage: "terminal",
                            message: model.terminals.isEmpty
                                ? "Spawn a terminal on one of your paired machines to get started."
                                : "Try widening the filter or clearing the search."
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
            .searchable(text: $model.search, prompt: "Title, dir, PR, ticket")
            .refreshable { await model.refresh() }
        }
    }

    private var noHosts: some View {
        ScrollView {
            VStack(spacing: 12) {
                EmptyState(title: "No machines paired yet", systemImage: "laptopcomputer.and.iphone",
                           message: "On your machine, run `optio login`, then `optio local add <dir>` for each directory you want to expose, and `optio local up` to connect. Your host will appear here.")
            }
            .frame(maxWidth: .infinity, minHeight: 400)
        }
    }

    private func statsBar(_ model: LocalHubModel) -> some View {
        @Bindable var model = model
        let s = model.stats
        return StatGrid(minimum: 100) {
                statTile("Needs you", s.needsYou, .yellow, "exclamationmark.triangle", selected: model.filter == .needsYou) {
                    model.filter = model.filter == .needsYou ? .all : .needsYou
                }
                statTile("Working", s.working, AppTheme.accent, "waveform.path.ecg", selected: model.filter == .active) {
                    model.filter = model.filter == .active ? .all : .active
                }
                statTile("Idle", s.idle, .secondary, "pause", selected: false, action: nil)
                statTile("Finished", s.finished, .green, "checkmark.circle", selected: model.filter == .exited) {
                    model.filter = model.filter == .exited ? .all : .exited
                }
                statTile(model.hosts.count == 1 ? "Host online" : "of \(model.hosts.count) hosts online",
                         s.hostsOnline, s.hostsOnline > 0 ? .green : .red, "server.rack", selected: false, action: nil)
        }
    }

    private func statTile(_ title: String, _ value: Int, _ color: Color, _ icon: String, selected: Bool, action: (() -> Void)?) -> some View {
        Button { action?() } label: {
            StatTile(title: title, value: "\(value)", color: color, systemImage: icon)
                .frame(maxWidth: .infinity)
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(selected ? color : .clear, lineWidth: 1.5))
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
    }

    private func hostsStrip(_ model: LocalHubModel) -> some View {
        @Bindable var model = model
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.hosts, id: \.id) { h in
                    let selected = model.hostFilter == h.id
                    Button {
                        if model.hosts.count > 1 { model.hostFilter = selected ? nil : h.id }
                    } label: {
                        HStack(spacing: 6) {
                            Circle().fill(h.state == .online ? Color.green : Color.secondary.opacity(0.4)).frame(width: 6, height: 6)
                            Text(h.name).font(.caption.weight(.medium))
                            Text("\(h.dirs.count) dir\(h.dirs.count == 1 ? "" : "s")").font(.caption2).foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(selected ? AnyShapeStyle(AppTheme.accent.opacity(0.18)) : AnyShapeStyle(.fill.tertiary), in: Capsule())
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
            .padding(.horizontal)
        }
    }
}

/// Compact card in the "Needs you" strip.
private struct NeedsYouCard: View {
    let terminal: LocalTerminal

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(terminal.title).font(.subheadline.weight(.medium)).lineLimit(1)
            HStack {
                Text(LocalPresentation.attentionLabel(terminal.attentionReason))
                    .font(.caption2).foregroundStyle(.yellow).lineLimit(1)
                Spacer(minLength: 4)
                if let at = terminal.lastActivityAt {
                    Text("waiting \(at.relativeDescription)").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(10)
        .frame(width: 220, alignment: .leading)
        .background(Color.yellow.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.yellow.opacity(0.3)))
    }
}

/// One terminal row: attention dot, title, state, where it runs, what it's
/// working on, and when it last did something (`terminal-row.tsx`).
struct TerminalRowView: View {
    let terminal: LocalTerminal
    var hostName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Circle().fill(LocalPresentation.rowDot(terminal)).frame(width: 7, height: 7)
                Text(terminal.title).font(.subheadline.weight(.medium)).lineLimit(1)
                Spacer(minLength: 4)
                StatusBadge(text: LocalPresentation.stateLabel(terminal), color: LocalPresentation.stateColor(terminal))
            }
            if terminal.attentionState == .needsYou {
                Text(LocalPresentation.attentionLabel(terminal.attentionReason))
                    .font(.caption).foregroundStyle(.yellow).lineLimit(1)
            }
            HStack(spacing: 8) {
                if let hostName {
                    Label(hostName, systemImage: "server.rack").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(LocalPresentation.dirTail(terminal.dir)).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                if let command = terminal.command, !command.isEmpty {
                    Text(command).font(.caption2.monospaced()).foregroundStyle(.tertiary).lineLimit(1)
                } else {
                    Text(specLabel).font(.caption2).foregroundStyle(.tertiary)
                }
                Spacer(minLength: 4)
                Text(LocalPresentation.activityDescription(terminal)).font(.caption2).foregroundStyle(.tertiary).monospacedDigit()
            }
            HStack(spacing: 6) {
                Image(systemName: LocalPresentation.spawnSourceIcon(terminal.spawnedBy)).font(.caption2).foregroundStyle(.tertiary)
                if terminal.state == .exited, let code = terminal.exitCode, code != 0 {
                    Text("exit \(Int(code))").font(.caption2).foregroundStyle(.red)
                }
                if LocalPresentation.isDead(terminal), let msg = terminal.errorMessage {
                    Text(msg).font(.caption2).foregroundStyle(terminal.state == .error ? .red : .secondary).lineLimit(1)
                }
                WorkLinkBadges(links: LocalPresentation.workLinks(terminal), max: 3)
            }
        }
        .padding(.vertical, 2)
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
