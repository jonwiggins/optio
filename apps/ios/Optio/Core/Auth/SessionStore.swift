import Foundation
import Observation

/// The signed-in user as returned by `GET /api/auth/me`.
struct CurrentUser: Codable, Hashable, Sendable {
    var id: String
    var email: String?
    var displayName: String?
    var avatarUrl: String?
    var role: String?
    var workspaceId: String?
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

    init() {
        api.onUnauthorized = { [weak self] in
            Task { @MainActor in self?.signOut() }
        }
    }

    /// Restores a previous sign-in from disk and verifies it against the server.
    func restore() async {
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
