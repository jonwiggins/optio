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

/// Owns the server URL, the Personal Access Token, and the current user.
/// Persists the URL in UserDefaults and the token in the Keychain.
@MainActor
@Observable
final class SessionStore {
    enum Phase: Equatable { case restoring, signedOut, signedIn }

    private(set) var phase: Phase = .restoring
    private(set) var user: CurrentUser?
    private(set) var serverURL: URL?
    /// Workspace override sent as `x-workspace-id`; nil = user's default workspace.
    var workspaceId: String? {
        didSet {
            UserDefaults.standard.set(workspaceId, forKey: Keys.workspace)
            api.workspaceId = workspaceId
        }
    }
    let api = APIClient()

    private enum Keys {
        static let serverURL = "optio.serverURL"
        static let workspace = "optio.workspaceId"
        static let token = "accessToken"
    }

    private var verifyingToken = false

    init() {
        // A single 401 from a user-scoped route is not proof the token is dead
        // (auth-disabled dev servers 401 on a few of them). Re-check identity and
        // only sign out when `/api/auth/me` itself rejects the token.
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
            signOut()
        } catch {
            // Network or other failure: keep the session.
        }
    }

    /// Restores a previous sign-in from disk and verifies it against the server.
    func restore() async {
        #if DEBUG
        // Dev affordance so the simulator can be driven from the command line:
        //   SIMCTL_CHILD_OPTIO_DEV_SERVER_URL=http://localhost:30400 SIMCTL_CHILD_OPTIO_DEV_TOKEN=dev \
        //     xcrun simctl launch booted dev.optio.ios
        let env = ProcessInfo.processInfo.environment
        if let devToken = env["OPTIO_DEV_TOKEN"], let devURL = env["OPTIO_DEV_SERVER_URL"] {
            try? Keychain.set(devToken, account: Keys.token)
            UserDefaults.standard.set(devURL, forKey: Keys.serverURL)
        }
        #endif
        guard let raw = UserDefaults.standard.string(forKey: Keys.serverURL),
              let url = URL(string: raw),
              let token = Keychain.get(account: Keys.token) else {
            phase = .signedOut
            return
        }
        workspaceId = UserDefaults.standard.string(forKey: Keys.workspace)
        api.configure(baseURL: url, token: token, workspaceId: workspaceId)
        serverURL = url
        do {
            user = try await api.currentUser()
            phase = .signedIn
        } catch let error as APIError where error.isUnauthorized {
            signOut()
        } catch {
            // Server unreachable — stay signed in with cached credentials so the
            // user can retry from inside the app once the tailnet is up.
            phase = .signedIn
        }
    }

    /// Verifies the credentials, then persists them.
    func signIn(serverURL url: URL, token: String) async throws {
        api.configure(baseURL: url, token: token, workspaceId: nil)
        let me = try await api.currentUser()
        try Keychain.set(token, account: Keys.token)
        UserDefaults.standard.set(url.absoluteString, forKey: Keys.serverURL)
        serverURL = url
        user = me
        phase = .signedIn
    }

    func signOut() {
        Keychain.delete(account: Keys.token)
        UserDefaults.standard.removeObject(forKey: Keys.serverURL)
        UserDefaults.standard.removeObject(forKey: Keys.workspace)
        api.configure(baseURL: nil, token: nil, workspaceId: nil)
        user = nil
        serverURL = nil
        workspaceId = nil
        phase = .signedOut
    }

    func refreshUser() async {
        user = try? await api.currentUser()
    }
}
