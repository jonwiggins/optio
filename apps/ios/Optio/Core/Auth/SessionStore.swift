import Foundation
import Observation

/// The signed-in user as returned by `GET /api/auth/me`.
struct CurrentUser: Codable, Hashable, Sendable {
    var id: String
    var provider: String?
    var email: String?
    var displayName: String?
    var avatarUrl: String?
    var workspaceId: String?
    /// Role in the current workspace (`workspaceRole` on the wire): admin / member / viewer.
    var role: String?

    enum CodingKeys: String, CodingKey {
        case id, provider, email, displayName, avatarUrl, workspaceId
        case role = "workspaceRole"
    }

    var isAdmin: Bool { role == "admin" }
    var canMutate: Bool { role == "admin" || role == "member" }
}

/// Owns the paired servers, which one is active, and the current user on it.
///
/// Profiles and tokens persist through `ServerRegistry` (App Group + keychain group)
/// so the widget extension sees the same list. The one `APIClient` / `EventHub` pair
/// is re-pointed on every switch; `generation` bumps so the tab shell rebuilds with
/// fresh screen state for the new server.
@MainActor
@Observable
final class SessionStore {
    enum Phase: Equatable { case restoring, signedOut, signedIn }

    private(set) var phase: Phase = .restoring
    private(set) var user: CurrentUser?
    private(set) var servers: [ServerProfile] = []
    private(set) var activeServer: ServerProfile?
    /// Incremented on every server switch; the signed-in shell is keyed on it.
    private(set) var generation = 0
    /// True between a switch starting and the new server answering `/api/auth/me`.
    private(set) var switching = false

    var serverURL: URL? { activeServer?.url }
    var hasMultipleServers: Bool { servers.count > 1 }

    /// Workspace override sent as `x-workspace-id`; nil = user's default workspace.
    var workspaceId: String? {
        didSet {
            api.workspaceId = workspaceId
            if var p = activeServer, p.workspaceId != workspaceId {
                p.workspaceId = workspaceId
                persist(p)
            }
        }
    }

    let api = APIClient()
    /// App-wide `/ws/events` fan-out; started on sign-in, stopped on sign-out.
    let events: EventHub

    private var verifyingToken = false

    init() {
        events = EventHub(api: api)
        // A single 401 from a user-scoped route is not proof the token is dead
        // (auth-disabled dev servers 401 on a few of them). Re-check identity and
        // only drop the server when `/api/auth/me` itself rejects the token.
        api.onUnauthorized = { [weak self] in
            Task { @MainActor in await self?.verifyTokenStillValid() }
        }
    }

    private func verifyTokenStillValid() async {
        guard !verifyingToken, phase == .signedIn else { return }
        verifyingToken = true
        defer { verifyingToken = false }
        do {
            user = try await api.currentUser()
        } catch let error as APIError where error.isUnauthorized {
            if let id = activeServer?.id { removeServer(id) }
        } catch {
            // Network or other failure: keep the session.
        }
    }

    // MARK: - Restore

    /// Restores the paired servers from disk, activates the last used one and
    /// verifies it against the server.
    func restore() async {
        #if DEBUG
        // Dev affordance so the simulator can be driven from the command line:
        //   SIMCTL_CHILD_OPTIO_DEV_SERVER_URL=http://localhost:30400 SIMCTL_CHILD_OPTIO_DEV_TOKEN=dev \
        //     xcrun simctl launch booted dev.optio.ios
        // Additional instances: OPTIO_DEV_SERVER_URL_2 / OPTIO_DEV_TOKEN_2 (…_3, …).
        applyDevServers()
        #endif
        ServerRegistry.migrateLegacyIfNeeded()
        reloadRegistry()
        guard let active = ServerRegistry.active, let token = ServerRegistry.token(for: active.id) else {
            phase = .signedOut
            return
        }
        activate(active, token: token)
        do {
            user = try await api.currentUser()
            phase = .signedIn
        } catch let error as APIError where error.isUnauthorized {
            removeServer(active.id)
            if phase != .signedIn { return }
        } catch {
            // Server unreachable — stay signed in with cached credentials so the
            // user can retry from inside the app once the tailnet is up.
            phase = .signedIn
        }
        if phase == .signedIn { events.start() }
    }

    #if DEBUG
    private func applyDevServers() {
        let env = ProcessInfo.processInfo.environment
        var profiles: [ServerProfile] = []
        for suffix in ["", "_2", "_3", "_4"] {
            guard let token = env["OPTIO_DEV_TOKEN\(suffix)"], let raw = env["OPTIO_DEV_SERVER_URL\(suffix)"], let url = URL(string: raw) else { continue }
            let name = env["OPTIO_DEV_SERVER_NAME\(suffix)"] ?? ServerProfile.defaultName(for: url)
            let existing = ServerRegistry.all.first { $0.url == url }
            // Stable ids so `optio://…?server=dev-server_2` can drive a switch from the CLI.
            let profile = ServerProfile(id: "dev-server\(suffix)", name: name, url: url,
                                        color: existing?.color ?? ServerColor.next(avoiding: profiles.map(\.color)))
            ServerRegistry.setToken(token, for: profile.id)
            profiles.append(profile)
        }
        guard !profiles.isEmpty else { return }
        ServerRegistry.all = profiles
        ServerRegistry.activeId = profiles[0].id
    }
    #endif

    private func reloadRegistry() {
        servers = ServerRegistry.configured
        activeServer = ServerRegistry.active
    }

    /// Points the shared client at `profile` without touching `phase`.
    private func activate(_ profile: ServerProfile, token: String) {
        ServerRegistry.activeId = profile.id
        activeServer = profile
        workspaceId = profile.workspaceId
        api.configure(baseURL: profile.url, token: token, workspaceId: profile.workspaceId)
        reloadRegistry()
    }

    private func persist(_ profile: ServerProfile) {
        ServerRegistry.upsert(profile)
        reloadRegistry()
    }

    // MARK: - Add / switch / remove

    /// Verifies the credentials against `url`, stores the profile, and makes it active.
    /// The first server signs the phone in; later ones just switch.
    @discardableResult
    func addServer(url: URL, token: String, name: String? = nil, color: ServerColor? = nil) async throws -> ServerProfile {
        let probe = APIClient()
        probe.configure(baseURL: url, token: token, workspaceId: nil)
        let me = try await probe.currentUser()

        // Re-pairing the same host replaces its token instead of adding a twin.
        let existing = servers.first { $0.url == url }
        var profile = existing ?? ServerProfile(
            name: name?.trimmingCharacters(in: .whitespaces).nonEmpty ?? ServerProfile.defaultName(for: url),
            url: url,
            color: color ?? ServerColor.next(avoiding: servers.map(\.color)))
        if let name = name?.trimmingCharacters(in: .whitespaces).nonEmpty { profile.name = name }
        if let color { profile.color = color }
        guard ServerRegistry.setToken(token, for: profile.id) else { throw Keychain.KeychainError.status(errSecIO) }
        ServerRegistry.upsert(profile)

        events.stop()
        activate(profile, token: token)
        user = me
        phase = .signedIn
        generation += 1
        events.start()
        return profile
    }

    /// Switches the whole app to another paired server. No-op for the active one.
    func switchTo(_ id: String) async {
        guard id != activeServer?.id, let profile = ServerRegistry.profile(id), let token = ServerRegistry.token(for: id) else { return }
        switching = true
        defer { switching = false }
        events.stop()
        user = nil
        activate(profile, token: token)
        generation += 1
        events.start()
        do {
            user = try await api.currentUser()
        } catch let error as APIError where error.isUnauthorized {
            removeServer(id)
        } catch {
            // Unreachable: stay on it; screens show their own retry.
        }
    }

    /// Renames / recolours a server, edits its address or workspace override. A new
    /// address on the active server re-points the client and rebuilds the shell.
    func updateServer(_ profile: ServerProfile) {
        let addressChanged = profile.id == activeServer?.id && profile.url != activeServer?.url
        persist(profile)
        guard profile.id == activeServer?.id else { return }
        if addressChanged, let token = ServerRegistry.token(for: profile.id) {
            events.stop()
            activate(profile, token: token)
            generation += 1
            events.start()
            Task { await refreshUser() }
        } else {
            activeServer = profile
            if workspaceId != profile.workspaceId { workspaceId = profile.workspaceId }
        }
    }

    /// Forgets a server and its token. Removing the active one moves to the next;
    /// removing the last one signs the phone out.
    func removeServer(_ id: String) {
        let wasActive = id == activeServer?.id
        ServerRegistry.remove(id)
        reloadRegistry()
        guard wasActive else { return }
        events.stop()
        user = nil
        if let next = ServerRegistry.active, let token = ServerRegistry.token(for: next.id) {
            activate(next, token: token)
            generation += 1
            events.start()
            Task { await refreshUser() }
        } else {
            api.configure(baseURL: nil, token: nil, workspaceId: nil)
            activeServer = nil
            workspaceId = nil
            phase = .signedOut
        }
    }

    /// Legacy single-server entry point: pairs the first server.
    func signIn(serverURL url: URL, token: String) async throws {
        try await addServer(url: url, token: token)
    }

    /// Removes the active server (the "Sign out" action on the account card).
    func signOut() {
        if let id = activeServer?.id { removeServer(id) }
    }

    func refreshUser() async {
        user = try? await api.currentUser()
    }

    /// A throwaway client for another paired server (notification actions, cross-server
    /// probes). Not observed; use `api` for the active server.
    func client(for serverId: String) -> APIClient? {
        guard let p = ServerRegistry.profile(serverId), let token = ServerRegistry.token(for: p.id) else { return nil }
        let c = APIClient()
        c.configure(baseURL: p.url, token: token, workspaceId: p.workspaceId)
        return c
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
