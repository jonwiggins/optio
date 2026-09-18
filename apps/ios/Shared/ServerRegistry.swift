import Foundation
import SwiftUI

/// One paired Optio instance: a laptop running the local stack, a cluster, a
/// colleague's tailnet box. The phone can hold several and switches between them;
/// the token for each lives in the keychain under `token.<id>`.
public struct ServerProfile: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    /// User-facing label ("MacBook Pro", "Studio", "prod"). Defaults to the host.
    public var name: String
    public var url: URL
    /// Identity colour on every surface that mixes servers (chips, widget sections).
    public var color: ServerColor
    /// Workspace override sent as `x-workspace-id`; nil = the user's default workspace.
    public var workspaceId: String?
    public var addedAt: Date

    public init(id: String = UUID().uuidString, name: String, url: URL, color: ServerColor, workspaceId: String? = nil, addedAt: Date = .now) {
        self.id = id
        self.name = name
        self.url = url
        self.color = color
        self.workspaceId = workspaceId
        self.addedAt = addedAt
    }

    public var host: String { url.host ?? url.absoluteString }

    /// Short label for tight spaces (widget headers): the name, or the first host label.
    public var shortName: String {
        let n = name.trimmingCharacters(in: .whitespaces)
        if !n.isEmpty { return n }
        return host.split(separator: ".").first.map(String.init) ?? host
    }

    public static func defaultName(for url: URL) -> String {
        (url.host ?? "server").split(separator: ".").first.map(String.init) ?? "server"
    }
}

/// The identity palette. Purple stays reserved for "needs you" app-wide, so the
/// first server gets `slate` (neutral) and later ones pick the next unused hue.
public enum ServerColor: String, Codable, CaseIterable, Hashable, Sendable {
    case slate, blue, teal, green, amber, rose, indigo

    public var label: String {
        switch self {
        case .slate: return "Slate"
        case .blue: return "Blue"
        case .teal: return "Teal"
        case .green: return "Green"
        case .amber: return "Amber"
        case .rose: return "Rose"
        case .indigo: return "Indigo"
        }
    }

    public var swiftUI: Color {
        switch self {
        case .slate: return Color(red: 0x64 / 255, green: 0x74 / 255, blue: 0x8B / 255)
        case .blue: return Color(red: 0x2F / 255, green: 0x6F / 255, blue: 0xED / 255)
        case .teal: return Color(red: 0x0F / 255, green: 0x9F / 255, blue: 0x9A / 255)
        case .green: return Color(red: 0x16 / 255, green: 0xA3 / 255, blue: 0x4A / 255)
        case .amber: return Color(red: 0xD9 / 255, green: 0x77 / 255, blue: 0x06 / 255)
        case .rose: return Color(red: 0xE1 / 255, green: 0x1D / 255, blue: 0x48 / 255)
        case .indigo: return Color(red: 0x4F / 255, green: 0x46 / 255, blue: 0xE5 / 255)
        }
    }

    /// The first colour not yet used by `existing`, cycling when the palette is exhausted.
    public static func next(avoiding existing: [ServerColor]) -> ServerColor {
        allCases.first { !existing.contains($0) } ?? allCases[existing.count % allCases.count]
    }
}

/// Persistence for the paired servers, shared between the app and the widget
/// extension through the App Group defaults (profiles) and keychain group (tokens).
/// Pure storage: `SessionStore` owns the live session and calls in here.
public enum ServerRegistry {
    enum Keys {
        static let servers = "optio.servers"
        static let activeId = "optio.activeServerId"
    }

    /// Posted (app process only) after any mutation so observers can re-sync.
    public static let changed = Notification.Name("optio.servers.changed")

    private static var defaults: UserDefaults { SharedCredentials.defaults }
    private static let encoder: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e }()
    private static let decoder: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }()

    // MARK: Profiles

    public static var all: [ServerProfile] {
        get { defaults.data(forKey: Keys.servers).flatMap { try? decoder.decode([ServerProfile].self, from: $0) } ?? [] }
        set {
            defaults.set(try? encoder.encode(newValue), forKey: Keys.servers)
            NotificationCenter.default.post(name: changed, object: nil)
        }
    }

    public static var activeId: String? {
        get { defaults.string(forKey: Keys.activeId) }
        set {
            defaults.set(newValue, forKey: Keys.activeId)
            NotificationCenter.default.post(name: changed, object: nil)
        }
    }

    public static var active: ServerProfile? {
        let servers = all
        if let id = activeId, let s = servers.first(where: { $0.id == id }) { return s }
        return servers.first
    }

    public static func profile(_ id: String) -> ServerProfile? { all.first { $0.id == id } }

    /// Servers with a usable token, active first, then in the order they were added.
    public static var configured: [ServerProfile] {
        let activeId = active?.id
        return all.filter { token(for: $0.id) != nil }
            .sorted { a, b in
                if a.id == activeId { return true }
                if b.id == activeId { return false }
                return a.addedAt < b.addedAt
            }
    }

    public static func upsert(_ profile: ServerProfile) {
        var servers = all
        if let i = servers.firstIndex(where: { $0.id == profile.id }) { servers[i] = profile } else { servers.append(profile) }
        all = servers
    }

    public static func remove(_ id: String) {
        SharedCredentials.deleteKeychain(account: tokenAccount(id))
        all = all.filter { $0.id != id }
        if activeId == id { activeId = all.first?.id }
    }

    // MARK: Tokens

    static func tokenAccount(_ id: String) -> String { "token.\(id)" }

    public static func token(for id: String) -> String? { SharedCredentials.readKeychain(account: tokenAccount(id)) }

    @discardableResult
    public static func setToken(_ token: String, for id: String) -> Bool {
        SharedCredentials.writeKeychain(token, account: tokenAccount(id))
    }

    // MARK: Migration

    /// Pre-multi-server installs stored one URL + one token under fixed keys. Turn
    /// that into the first profile (once) so nothing is lost on update.
    public static func migrateLegacyIfNeeded() {
        guard all.isEmpty, let url = SharedCredentials.legacyServerURL, let token = SharedCredentials.legacyToken else { return }
        let profile = ServerProfile(name: ServerProfile.defaultName(for: url), url: url, color: .slate, workspaceId: SharedCredentials.legacyWorkspaceId)
        guard setToken(token, for: profile.id) else { return }
        all = [profile]
        activeId = profile.id
        SharedCredentials.clearLegacy()
    }
}
