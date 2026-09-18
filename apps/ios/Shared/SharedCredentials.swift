import Foundation
import Security

/// Credentials shared between the app and the widget extension.
///
/// Base URL and workspace live in the App Group's UserDefaults; the PAT lives in a
/// shared keychain access group. When the entitlements are unavailable (no team
/// configured, or a simulator build without provisioning) every accessor falls back
/// to the app-private store so the app itself keeps working; only the extension
/// then sees nothing and renders its signed-out state.
public enum SharedCredentials {
    public static let appGroup = "group.dev.optio.ios"
    public static let keychainGroup = "dev.optio.ios.shared"
    static let service = "dev.optio.ios"
    static let tokenAccount = "accessToken"

    enum Keys {
        static let serverURL = "optio.serverURL"
        static let workspaceId = "optio.workspaceId"
    }

    /// App Group defaults when available, else standard defaults.
    public static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }

    public static var serverURL: URL? {
        get { defaults.string(forKey: Keys.serverURL).flatMap(URL.init(string:)) }
        set { defaults.set(newValue?.absoluteString, forKey: Keys.serverURL) }
    }

    public static var workspaceId: String? {
        get { defaults.string(forKey: Keys.workspaceId) }
        set { defaults.set(newValue, forKey: Keys.workspaceId) }
    }

    // MARK: - Token (keychain)

    private static func baseQuery(shared: Bool) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount,
        ]
        if shared { q[kSecAttrAccessGroup as String] = keychainGroup }
        return q
    }

    /// Reads from the shared group first, then the app-private item.
    public static var token: String? {
        for shared in [true, false] {
            var q = baseQuery(shared: shared)
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
    public static func setToken(_ value: String) -> Bool {
        let data = Data(value.utf8)
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        for shared in [true, false] {
            let q = baseQuery(shared: shared)
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

    public static func clearToken() {
        for shared in [true, false] { SecItemDelete(baseQuery(shared: shared) as CFDictionary) }
    }

    public static func clearAll() {
        clearToken()
        defaults.removeObject(forKey: Keys.serverURL)
        defaults.removeObject(forKey: Keys.workspaceId)
    }

    public static var isConfigured: Bool { serverURL != nil && token != nil }
}
