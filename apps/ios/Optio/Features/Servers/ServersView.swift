import SwiftUI

/// Manage the paired servers: switch, rename, recolour, forget, add. Each row
/// probes its server so the list doubles as a reachability check across laptops.
struct ServersView: View {
    /// Presented modally (Done button) rather than pushed from More.
    var inSheet = false
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var status: [String: ServerProbe] = [:]
    @State private var showAdd = false
    @State private var confirmRemove: ServerProfile?
    @State private var editing: ServerProfile?

    var body: some View {
        List {
            Section {
                ForEach(session.servers) { server in
                    ServerRow(server: server, isActive: server.id == session.activeServer?.id, probe: status[server.id],
                              onSelect: { Task { await session.switchTo(server.id) } },
                              onEdit: { editing = server })
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        Button { editing = server } label: { Label("Edit", systemImage: "pencil") }.tint(AppTheme.accent)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) { confirmRemove = server } label: { Label("Forget", systemImage: "trash") }
                    }
                    .contextMenu {
                        Button { editing = server } label: { Label("Edit name, colour, URL", systemImage: "pencil") }
                        Button(role: .destructive) { confirmRemove = server } label: { Label("Forget", systemImage: "trash") }
                    }
                }
            } header: {
                SectionHeader(title: "Paired servers").textCase(nil)
            } footer: {
                Text("Tap a server to switch the whole app to it; the pencil edits its name, colour and address. Widgets can show one server or all of them.")
            }

            Section {
                Button { showAdd = true } label: { Label("Add server", systemImage: "plus") }
            }
        }
        .navigationTitle("Servers")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if inSheet {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
        }
        .navigationDestination(item: $editing) { server in ServerEditView(server: server) }
        .task(id: session.servers.map(\.id)) { await probeAll() }
        .refreshable { await probeAll() }
        .sheet(isPresented: $showAdd) { SignInView(mode: .add) }
        .confirmationDialog("Forget \(confirmRemove?.name ?? "this server")?", isPresented: Binding(get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } }), titleVisibility: .visible) {
            Button("Forget server", role: .destructive) {
                if let s = confirmRemove { session.removeServer(s.id) }
                confirmRemove = nil
            }
        } message: {
            Text("Its access token is removed from this phone. Nothing changes on the server.")
        }
    }

    private func probeAll() async {
        await withTaskGroup(of: (String, ServerProbe).self) { group in
            for server in session.servers {
                group.addTask { (server.id, await ServerProbe.run(server)) }
            }
            for await (id, probe) in group { status[id] = probe }
        }
    }
}

/// Result of `GET /api/auth/me` against one server.
struct ServerProbe: Equatable {
    enum State: Equatable { case online, unauthorized, unreachable }
    var state: State
    var user: String?

    static func run(_ server: ServerProfile) async -> ServerProbe {
        struct Me: Decodable { struct U: Decodable { var email: String?; var displayName: String? }; var user: U }
        guard let fetch = SharedFetch(server: server) else { return ServerProbe(state: .unauthorized) }
        do {
            let me = try await fetch.get("/api/auth/me", as: Me.self, timeout: 6)
            return ServerProbe(state: .online, user: me.user.displayName ?? me.user.email)
        } catch let e as SharedFetch.Failure where e.status == 401 {
            return ServerProbe(state: .unauthorized)
        } catch {
            return ServerProbe(state: .unreachable)
        }
    }

    var label: String {
        switch state {
        case .online: return "Online"
        case .unauthorized: return "Token rejected"
        case .unreachable: return "Unreachable"
        }
    }

    var tone: Tone {
        switch state {
        case .online: return .success
        case .unauthorized: return .danger
        case .unreachable: return .idle
        }
    }
}

struct ServerRow: View {
    let server: ServerProfile
    let isActive: Bool
    let probe: ServerProbe?
    let onSelect: () -> Void
    let onEdit: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: Spacing.m) {
                ServerDot(color: server.color, size: 12)
                VStack(alignment: .leading, spacing: 2) {
                    Text(server.name).font(.body).foregroundStyle(.primary)
                    Text(server.host).font(.monoFootnote).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    HStack(spacing: 4) {
                        if let probe {
                            Text(probe.label).foregroundStyle(probe.tone.textStyle)
                            if let u = probe.user { Text("· \(u)").foregroundStyle(.tertiary) }
                        } else {
                            Text("Checking…").foregroundStyle(.tertiary)
                        }
                    }
                    .font(.caption)
                    .lineLimit(1)
                }
                Spacer()
                if isActive {
                    Image(systemName: "checkmark").foregroundStyle(AppTheme.accent).fontWeight(.semibold)
                }
                Button(action: onEdit) {
                    Image(systemName: "pencil.circle")
                        .font(.title3)
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Edit \(server.name)")
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(server.name), \(probe?.label ?? "checking")\(isActive ? ", current" : "")")
    }
}

/// Rename, recolour, or forget one server.
struct ServerEditView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var draft: ServerProfile
    @State private var urlText: String
    @State private var confirmRemove = false

    init(server: ServerProfile) {
        _draft = State(initialValue: server)
        _urlText = State(initialValue: server.url.absoluteString)
    }

    /// The address field, normalised like sign-in (scheme defaults to https).
    private var editedURL: URL? {
        var raw = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        if !raw.contains("://") { raw = "https://" + raw }
        guard let url = URL(string: raw), url.host != nil else { return nil }
        return url
    }

    var body: some View {
        Form {
            Section {
                TextField("MacBook Pro", text: $draft.name)
                    .textInputAutocapitalization(.words)
            } header: {
                Text("Name")
            } footer: {
                Text("Shown in the switcher, on the Overview and in widget sections.")
            }
            Section {
                TextField("http://laptop.tailnet.ts.net:30400", text: $urlText)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.body.monospaced())
            } header: {
                Text("Address")
            } footer: {
                Text(editedURL == nil ? "Enter the server address, including the port if it isn't 443." : "The stored token is kept; change it by adding the server again.")
                    .foregroundStyle(editedURL == nil ? .red : .secondary)
            }
            Section {
                ServerColorPicker(selection: $draft.color)
            } header: {
                Text("Colour")
            } footer: {
                Text("Marks this server's items in widgets, the Live Activity and the switcher.")
            }
            if let ws = draft.workspaceId {
                Section("Server") {
                    MoreInfoRow(label: "Workspace", value: ws, mono: true)
                }
            }
            Section {
                Button("Forget this server", role: .destructive) { confirmRemove = true }
            }
        }
        .navigationTitle("Edit Server")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    var p = draft
                    if let url = editedURL { p.url = url }
                    p.name = p.name.trimmingCharacters(in: .whitespaces)
                    if p.name.isEmpty { p.name = ServerProfile.defaultName(for: p.url) }
                    session.updateServer(p)
                    dismiss()
                }
                .disabled(editedURL == nil)
            }
        }
        .confirmationDialog("Forget \(draft.name)?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Forget server", role: .destructive) {
                session.removeServer(draft.id)
                dismiss()
            }
        } message: {
            Text("Its access token is removed from this phone.")
        }
    }
}

/// Swatch row for `ServerColor`.
struct ServerColorPicker: View {
    @Binding var selection: ServerColor

    var body: some View {
        HStack(spacing: 14) {
            ForEach(ServerColor.allCases, id: \.self) { c in
                Button {
                    selection = c
                } label: {
                    ZStack {
                        Circle().fill(c.swiftUI).frame(width: 28, height: 28)
                        if c == selection {
                            Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(.white)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(c.label)
                .accessibilityAddTraits(c == selection ? .isSelected : [])
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .sensoryFeedback(.selection, trigger: selection)
    }
}
