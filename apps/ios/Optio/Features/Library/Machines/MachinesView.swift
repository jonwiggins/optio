import SwiftUI

/// Paired Optio Local hosts (`GET /api/local/hosts`): name, online state,
/// platform / arch / daemon version, last seen, and the directory allowlist
/// with detected checkouts marked. Sessions that run on a machine are in the
/// Sessions list; this is the machine itself.
struct MachinesView: View {
    @Environment(APIClient.self) private var api
    @State private var hosts: [LocalHost] = []
    @State private var loaded = false
    @State private var error: Error?
    @State private var actionError: String?
    @State private var pendingForget: LocalHost?

    private var sorted: [LocalHost] {
        hosts.sorted { a, b in
            if (a.state == .online) != (b.state == .online) { return a.state == .online }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    var body: some View {
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
                        MachineCard(host: host)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .contextMenu {
                                Button(role: .destructive) { pendingForget = host } label: { Label("Forget machine", systemImage: "trash") }
                            }
                    }
                }
            }
        }
        .listStyle(.plain)
        .task {
            await refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                await refresh()
            }
        }
        .refreshable { await refresh() }
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

/// One machine: identity line, facts, then its directories.
private struct MachineCard: View {
    let host: LocalHost

    private var online: Bool { host.state == .online }

    private var facts: String {
        var parts = [host.hostname, host.platform]
        if let arch = host.arch { parts.append(arch) }
        if let v = host.daemonVersion { parts.append("daemon \(v)") }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var seen: String? {
        if online { return "online" }
        if let seen = host.lastSeenAt { return "seen \(seen.relativeDescription)" }
        return "offline"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
                StateDot(tone: online ? .success : .idle).padding(.top, 2)
                Text(host.name).font(.body.weight(.semibold)).lineLimit(1)
                Spacer(minLength: Spacing.s)
                if let seen {
                    Text(seen)
                        .font(.footnote)
                        .foregroundStyle(online ? Tone.success.textStyle : AnyShapeStyle(.tertiary))
                        .lineLimit(1)
                }
            }
            Text(facts).font(.footnote).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)

            if host.dirs.isEmpty {
                Text("No directories exposed — `optio local add <dir>` on the machine.")
                    .font(.footnote).foregroundStyle(.tertiary)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(host.dirs, id: \.path) { dir in
                        HStack(spacing: 6) {
                            Image(systemName: dir.repoUrl == nil ? "folder" : "arrow.triangle.branch")
                                .font(.caption)
                                .foregroundStyle(dir.repoUrl == nil ? AnyShapeStyle(.tertiary) : AnyShapeStyle(AppTheme.accent))
                                .frame(width: 14)
                            Text(SessionsFeed.shortDir(dir.path) ?? dir.path)
                                .font(.caption.monospaced())
                                .lineLimit(1)
                                .truncationMode(.head)
                            if let repo = SessionsFeed.shortRepo(dir.repoUrl) {
                                Spacer(minLength: Spacing.s)
                                Text(repo).font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                            }
                        }
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(Spacing.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Surface.card, in: Radius.cardShape)
        .padding(.horizontal, Spacing.l)
        .padding(.vertical, Spacing.xs)
    }
}
