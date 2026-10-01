import SwiftUI

/// Where work runs (the web's `/machines`). Each paired Optio Local host —
/// online first — with the work on it: what's live there now and what's set up
/// to run there (automations, Jobs and scheduled Tasks pointed at it), then, as
/// the machine's setup, its directory allowlist. Then the Optio pods: the
/// cluster as the other place work runs, grouped by repo, Jobs and persistent
/// agents. Rows come from the Work feed (`WorkFeedModel`), grouped by
/// `where.hostId` in `WorkPlaces`; tapping one opens the same detail screen as
/// on the Work tab. Local Automations are still created from the link below.
struct MachinesView: View {
    @Environment(APIClient.self) private var api
    @State private var hosts: [LocalHost] = []
    @State private var loaded = false
    @State private var error: Error?
    @State private var actionError: String?
    @State private var pendingForget: LocalHost?
    @State private var feed: WorkFeedModel?

    private var sorted: [LocalHost] {
        hosts.sorted { a, b in
            if (a.state == .online) != (b.state == .online) { return a.state == .online }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    private var places: WorkPlaces {
        WorkPlaces(rows: feed?.rows ?? [], hostIds: hosts.map(\.id))
    }

    private var feedLoading: Bool { feed?.loading ?? true }

    var body: some View {
        let places = places
        List {
            if let error {
                ErrorRow(error: error, what: "machines") { Task { await refresh() } }
            }
            if !loaded, error == nil {
                SkeletonRows()
            } else if loaded, hosts.isEmpty {
                EmptyState(title: "No machines paired", systemImage: "laptopcomputer.and.iphone",
                           message: "On your machine, run `optio login`, then `optio local add <dir>` for each directory to expose, and `optio local up` to connect. It will appear here.")
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            } else {
                ForEach(sorted, id: \.id) { host in
                    Section {
                        placeRows(places.machines[host.id] ?? PlaceWork(),
                                  whereLabel: { WorkFeed.shortDir($0.where.dir) },
                                  empty: "Nothing running here, and nothing set up to run here.")
                        MachineDirectories(host: host)
                    } header: {
                        MachineHeader(host: host, summary: places.machines[host.id]?.nowSummary) {
                            pendingForget = host
                        }
                        .textCase(nil)
                    }
                }
                if !places.otherMachines.isEmpty {
                    Section {
                        placeRows(places.otherMachines, empty: "")
                    } header: {
                        SectionHeader(title: "Other machines", detail: "a teammate's, or removed").textCase(nil)
                    }
                }
            }

            if loaded {
                podSections(places.pods)
            }

            if loaded, !hosts.isEmpty {
                Section {
                    NavigationLink(value: MachinesRoute.automations) {
                        Label("Automations", systemImage: "square.stack.3d.up")
                    }
                } footer: {
                    Text("Agents and terminals that start on one of these machines when something happens — a schedule, a webhook, a ticket, or a GitHub / Slack / Linear event.")
                }
            }
        }
        .listStyle(.plain)
        .workDestinations()
        .navigationDestination(for: MachinesRoute.self) { route in
            switch route {
            case .automations: LocalBlueprintsView(hosts: hosts)
            }
        }
        .navigationDestination(for: LocalRoute.self) { route in
            switch route {
            case .blueprint(let id): LocalBlueprintDetailView(blueprintId: id, hosts: hosts)
            case .terminal(let id): LocalTerminalScreen(terminalId: id, hosts: hosts)
            }
        }
        .task {
            if feed == nil { feed = WorkFeedModel(api: api) }
            feed?.start()
            await refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                await refresh()
            }
        }
        .onDisappear { feed?.stop() }
        .refreshable {
            async let machines: Void = refresh()
            async let work: Void? = feed?.refresh()
            _ = await (machines, work)
        }
        .confirmationDialog("Forget “\(pendingForget?.name ?? "")”?", isPresented: Binding(get: { pendingForget != nil }, set: { if !$0 { pendingForget = nil } }), titleVisibility: .visible) {
            Button("Forget", role: .destructive) {
                if let h = pendingForget { Task { await forget(h) } }
                pendingForget = nil
            }
        } message: {
            Text("Removes the pairing. Run `optio local up` on the machine to pair it again.")
        }
        .errorToast($actionError)
    }

    /// The cluster: one section per repo / Jobs / agents, after a heading row.
    @ViewBuilder
    private func podSections(_ groups: [PodGroup]) -> some View {
        Section {
            if groups.isEmpty {
                Text(feedLoading ? "Loading…" : "Nothing running in Optio pods, and nothing set up to.")
                    .font(.footnote).foregroundStyle(.tertiary)
            }
        } header: {
            VStack(alignment: .leading, spacing: 2) {
                Label("Optio pods", systemImage: "server.rack").font(.headline).foregroundStyle(.primary)
                Text("Work that runs in the cluster, with the workspace's secrets and connections.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .textCase(nil)
            .padding(.top, Spacing.m)
        }
        ForEach(groups) { group in
            Section {
                placeRows(group.work,
                          whereLabel: group.kind == .repo ? { _ in "Optio pod" } : nil,
                          setUpTitle: group.kind == .agents ? "Standing by" : "Set up to run",
                          empty: "")
            } header: {
                HStack(spacing: Spacing.xs) {
                    Image(systemName: group.systemImage).font(.caption).foregroundStyle(.secondary)
                    Text(group.label)
                        .font(group.kind == .repo ? .footnote.monospaced().weight(.semibold) : .footnote.weight(.semibold))
                        .foregroundStyle(Color(.secondaryLabel))
                        .lineLimit(1).truncationMode(.head)
                    Spacer(minLength: Spacing.s)
                    if let summary = group.work.nowSummary {
                        Text(summary).font(.footnote).foregroundStyle(Color(.tertiaryLabel))
                    }
                }
                .textCase(nil)
            }
        }
    }

    /// A place's rows: "Now", then what is set up to run there; a quiet line when empty.
    @ViewBuilder
    private func placeRows(_ work: PlaceWork,
                           whereLabel: ((WorkRow) -> String?)? = nil,
                           setUpTitle: String = "Set up to run here",
                           empty: String) -> some View {
        if work.isEmpty {
            if !empty.isEmpty {
                Text(feedLoading ? "Loading…" : empty).font(.footnote).foregroundStyle(.tertiary)
            }
        } else {
            if !work.now.isEmpty {
                SubHeading(title: "Now")
                ForEach(work.now) { row in
                    NavigationLink(value: row.destination) { WorkRowView(row: row, whereLabel: whereLabel?(row)) }
                }
            }
            if !work.setUp.isEmpty {
                SubHeading(title: setUpTitle)
                ForEach(work.setUp) { row in
                    NavigationLink(value: row.destination) { WorkRowView(row: row, whereLabel: whereLabel?(row)) }
                }
            }
        }
    }

    private func refresh() async {
        do {
            hosts = try await api.listLocalHosts()
            error = nil
        } catch {
            if !loaded { self.error = error }
        }
        loaded = true
    }

    private func forget(_ host: LocalHost) async {
        do {
            try await api.deleteLocalHost(host.id)
            hosts.removeAll { $0.id == host.id }
        } catch {
            actionError = error.localizedDescription
        }
    }
}

/// Pushed from the Machines list.
enum MachinesRoute: Hashable {
    case automations
}

/// "Now" / "Set up to run here" inside a place's section.
private struct SubHeading: View {
    let title: String

    var body: some View {
        Text(title.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.tertiary)
            .listRowSeparator(.hidden)
            .padding(.top, Spacing.xs)
    }
}

/// A machine's section header: who it is, whether it's connected, its facts,
/// what's live on it, and a menu to forget it.
private struct MachineHeader: View {
    let host: LocalHost
    let summary: String?
    let onForget: () -> Void

    private var online: Bool { host.state == .online }

    private var facts: String {
        var parts = [host.hostname, host.platform]
        if let arch = host.arch { parts.append(arch) }
        if let v = host.daemonVersion { parts.append("daemon \(v)") }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var seen: String {
        if online { return "online" }
        if let seen = host.lastSeenAt { return "seen \(seen.relativeDescription)" }
        return "offline"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                StateDot(tone: online ? .success : .idle)
                Text(host.name).font(.headline).foregroundStyle(.primary).lineLimit(1)
                Text(seen)
                    .font(.footnote)
                    .foregroundStyle(online ? Tone.success.textStyle : AnyShapeStyle(Color(.tertiaryLabel)))
                    .lineLimit(1)
                Spacer(minLength: Spacing.s)
                Menu {
                    Button(role: .destructive, action: onForget) { Label("Forget machine", systemImage: "trash") }
                } label: {
                    Image(systemName: "ellipsis.circle").foregroundStyle(.secondary)
                }
                .accessibilityLabel("\(host.name) options")
            }
            HStack(spacing: Spacing.s) {
                Text(facts).lineLimit(1).truncationMode(.middle)
                if let summary {
                    Spacer(minLength: Spacing.s)
                    Text(summary).foregroundStyle(Color(.secondaryLabel)).lineLimit(1)
                }
            }
            .font(.footnote)
            .foregroundStyle(Color(.tertiaryLabel))
        }
        .padding(.top, Spacing.m)
    }
}

/// The machine's setup: its directory allowlist, folded away.
private struct MachineDirectories: View {
    let host: LocalHost
    @State private var open = false

    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            if host.dirs.isEmpty {
                Text("No directories exposed — `optio local add <dir>` on the machine.")
                    .font(.footnote).foregroundStyle(.tertiary)
            } else {
                ForEach(host.dirs, id: \.path) { dir in
                    HStack(spacing: 6) {
                        Image(systemName: dir.repoUrl == nil ? "folder" : "arrow.triangle.branch")
                            .font(.caption)
                            .foregroundStyle(dir.repoUrl == nil ? AnyShapeStyle(.tertiary) : AnyShapeStyle(AppTheme.accent))
                            .frame(width: 14)
                        Text(WorkFeed.shortDir(dir.path) ?? dir.path)
                            .font(.caption.monospaced())
                            .lineLimit(1)
                            .truncationMode(.head)
                        if let repo = WorkFeed.shortRepo(dir.repoUrl) {
                            Spacer(minLength: Spacing.s)
                            Text(repo).font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                        }
                    }
                }
            }
        } label: {
            Label("Directories (\(host.dirs.count))", systemImage: "folder")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}
