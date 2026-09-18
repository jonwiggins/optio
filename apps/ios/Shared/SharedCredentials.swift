import Foundation
import Security

/// Credentials shared between the app and the widget extension.
///
/// Profiles live in the App Group's UserDefaults (see `ServerRegistry`); tokens live
/// in a shared keychain access group, one item per server. When the entitlements are
/// unavailable (no team configured, or a simulator build without provisioning) every
/// accessor falls back to the app-private store so the app itself keeps working; only
/// the extension then sees nothing and renders its signed-out state.
///
/// The `serverURL` / `token` / `workspaceId` accessors describe the **active** server
/// and exist for callers that only ever want "the current one" (widgets' default,
/// intents). Multi-server surfaces go through `ServerRegistry` directly.
public enum SharedCredentials {
    public static let appGroup = "group.dev.optio.ios"
    public static let keychainGroup = "dev.optio.ios.shared"
    static let service = "dev.optio.ios"
    static let legacyTokenAccount = "accessToken"

    enum Keys {
        static let legacyServerURL = "optio.serverURL"
        static let legacyWorkspaceId = "optio.workspaceId"
    }

    /// App Group defaults when available, else standard defaults.
    public static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }

    // MARK: - Active server

    public static var serverURL: URL? { ServerRegistry.active?.url }

    public static var token: String? {
        guard let id = ServerRegistry.active?.id else { return nil }
        return ServerRegistry.token(for: id)
    }

    public static var workspaceId: String? {
        get { ServerRegistry.active?.workspaceId }
        set {
            guard var p = ServerRegistry.active else { return }
            p.workspaceId = newValue
            ServerRegistry.upsert(p)
        }
    }

    public static var isConfigured: Bool { serverURL != nil && token != nil }

    // MARK: - Legacy single-server keys (read by the migration only)

    static var legacyServerURL: URL? { defaults.string(forKey: Keys.legacyServerURL).flatMap(URL.init(string:)) }
    static var legacyWorkspaceId: String? { defaults.string(forKey: Keys.legacyWorkspaceId) }
    static var legacyToken: String? { readKeychain(account: legacyTokenAccount) }

    static func clearLegacy() {
        deleteKeychain(account: legacyTokenAccount)
        defaults.removeObject(forKey: Keys.legacyServerURL)
        defaults.removeObject(forKey: Keys.legacyWorkspaceId)
    }

    // MARK: - Keychain

    private static func baseQuery(account: String, shared: Bool) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if shared { q[kSecAttrAccessGroup as String] = keychainGroup }
        return q
    }

    /// Reads from the shared group first, then the app-private item.
    static func readKeychain(account: String) -> String? {
        for shared in [true, false] {
            var q = baseQuery(account: account, shared: shared)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var item: CFTypeRef?
            if SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
               let data = item as? Data, let s = String(data: data, encoding: .utf8) {
                return s
            }
        }
        return nil
    }

    /// Writes to the shared group when the entitlement allows it, else app-private.
    @discardableResult
    static func writeKeychain(_ value: String, account: String) -> Bool {
        let data = Data(value.utf8)
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        for shared in [true, false] {
            let q = baseQuery(account: account, shared: shared)
            var status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
            if status == errSecItemNotFound {
                var add = q
                add.merge(attrs) { $1 }
                status = SecItemAdd(add as CFDictionary, nil)
            }
            if status == errSecSuccess { return true }
            // errSecMissingEntitlement (-34018) → fall through to the private store.
        }
        return false
    }

    static func deleteKeychain(account: String) {
        for shared in [true, false] { SecItemDelete(baseQuery(account: account, shared: shared) as CFDictionary) }
    }
}
