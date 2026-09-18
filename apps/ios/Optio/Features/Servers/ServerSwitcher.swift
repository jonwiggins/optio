import SwiftUI

/// The identity dot every server carries. Same size as the state dot so it sits
/// in rows and chips without shifting the baseline.
struct ServerDot: View {
    let color: ServerColor
    var size: CGFloat = 8

    var body: some View {
        Circle()
            .fill(color.swiftUI)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// Dot + name capsule: the current server, wherever the user needs to know which
/// machine a screen is talking to.
struct ServerChip: View {
    let server: ServerProfile
    var prominent = false

    var body: some View {
        HStack(spacing: 6) {
            ServerDot(color: server.color)
            Text(server.shortName)
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
            if prominent {
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(server.color.swiftUI.opacity(0.12), in: Capsule())
        .foregroundStyle(.primary)
    }
}

/// Toolbar control that names the active server and switches between the paired
/// ones. Shown on every hub so the answer to "which laptop is this?" is one glance
/// away. With a single server it still names it (no menu, no chevron) so the app
/// never hides where it is connected.
struct ServerSwitcherMenu: View {
    @Environment(SessionStore.self) private var session
    @State private var showAdd = false
    @State private var showManage = false

    var body: some View {
        Group {
            if let active = session.activeServer {
                Menu {
                    Section("Connected to") {
                        ForEach(session.servers) { server in
                            Button {
                                Task { await session.switchTo(server.id) }
                            } label: {
                                if server.id == active.id {
                                    Label(server.name, systemImage: "checkmark")
                                } else {
                                    Text(server.name)
                                }
                                Text(server.host)
                            }
                        }
                    }
                    Section {
                        Button { showAdd = true } label: { Label("Add server…", systemImage: "plus") }
                        Button { showManage = true } label: { Label("Manage servers…", systemImage: "slider.horizontal.3") }
                    }
                } label: {
                    ServerChip(server: active, prominent: session.hasMultipleServers)
                        .overlay {
                            if session.switching { ProgressView().controlSize(.mini) }
                        }
                }
                .menuOrder(.fixed)
                .tint(.primary)
                .accessibilityLabel("Server: \(active.name)")
                .accessibilityHint("Switch between paired servers")
            }
        }
        .sheet(isPresented: $showAdd) {
            SignInView(mode: .add)
        }
        .sheet(isPresented: $showManage) {
            NavigationStack { ServersView(inSheet: true) }
        }
    }
}

extension View {
    /// Puts the server switcher in the leading toolbar slot of a hub.
    func serverSwitcherToolbar() -> some View {
        toolbar {
            ToolbarItem(placement: .topBarLeading) { ServerSwitcherMenu() }
        }
    }
}
