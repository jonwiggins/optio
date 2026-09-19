import Foundation

/// `optio://` URL scheme shared by the app, widgets, Live Activity buttons and intents.
///
///   optio://tasks/<id>              optio://local/<id>?compose=1
///   optio://agents/<id>?compose=1   optio://sessions/<id>
///   optio://sessions/new            (the New session sheet)
///   optio://needs-you               (the Sessions list, Active view — needs-you rows rank first)
///   optio://section/sessions?view=active|recurring|agents|history|all   (`.sessions(view:)`)
///   optio://section/<name>          (sessions|reviews|inbox|prompts|repos|machines|connections|analytics|costs|
///                                    activity|cluster|more; legacy tasks|jobs|scheduled|agents|local|issues map onto those)
public enum DeepLink: Hashable, Sendable {
    case task(String), local(String, compose: Bool), agent(String, compose: Bool), session(String)
    case needsYou
    /// The New session sheet (`optio://sessions/new`); controls and widgets start work from here.
    case newSession
    /// The Sessions list in a named view (`optio://section/sessions?view=…`).
    case sessions(view: String)
    case section(String)

    public static let scheme = "optio"
    /// Query key carrying a `ServerProfile.id`; the app switches to that server before
    /// routing, so a tap on one laptop's item lands there even when another is active.
    public static let serverQuery = "server"

    public var url: URL { url(server: nil) }

    public func url(server: String?) -> URL {
        var c = URLComponents()
        c.scheme = Self.scheme
        switch self {
        case .task(let id): c.host = "tasks"; c.path = "/\(id)"
        case .local(let id, let compose): c.host = "local"; c.path = "/\(id)"; if compose { c.queryItems = [.init(name: "compose", value: "1")] }
        case .agent(let id, let compose): c.host = "agents"; c.path = "/\(id)"; if compose { c.queryItems = [.init(name: "compose", value: "1")] }
        case .session(let id): c.host = "sessions"; c.path = "/\(id)"
        case .newSession: c.host = "sessions"; c.path = "/new"
        case .needsYou: c.host = "needs-you"
        case .sessions(let view): c.host = "section"; c.path = "/sessions"; c.queryItems = [.init(name: "view", value: view)]
        case .section(let name): c.host = "section"; c.path = "/\(name)"
        }
        if let server { c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: Self.serverQuery, value: server)] }
        return c.url!
    }

    /// The `server=` hint on an `optio://` URL, if any.
    public static func serverId(in url: URL) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == serverQuery }?.value
    }

    public init?(url: URL) {
        guard url.scheme == Self.scheme, let host = url.host else { return nil }
        let id = url.pathComponents.dropFirst().first
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let compose = query.contains { $0.name == "compose" && $0.value == "1" }
        let view = query.first { $0.name == "view" }?.value
        switch (host, id) {
        case ("tasks", let id?): self = .task(id)
        case ("local", let id?): self = .local(id, compose: compose)
        case ("agents", let id?): self = .agent(id, compose: compose)
        case ("sessions", "new"): self = .newSession
        case ("sessions", let id?): self = .session(id)
        case ("needs-you", _): self = .needsYou
        case ("section", "sessions") where view != nil: self = .sessions(view: view!)
        case ("section", let name?): self = .section(name)
        default: return nil
        }
    }
}
