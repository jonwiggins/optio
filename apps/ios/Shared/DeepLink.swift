import Foundation

/// `optio://` URL scheme shared by the app, widgets, Live Activity buttons and intents.
///
///   optio://tasks/<id>              optio://local/<id>?compose=1
///   optio://agents/<id>?compose=1   optio://sessions/<id>
///   optio://needs-you               (oldest needs-you item, or the Local hub)
///   optio://section/<name>          (tasks|jobs|reviews|issues|scheduled|agents|sessions|local|analytics|costs|activity|cluster|more)
public enum DeepLink: Hashable, Sendable {
    case task(String), local(String, compose: Bool), agent(String, compose: Bool), session(String)
    case needsYou
    case section(String)

    public static let scheme = "optio"

    public var url: URL {
        var c = URLComponents()
        c.scheme = Self.scheme
        switch self {
        case .task(let id): c.host = "tasks"; c.path = "/\(id)"
        case .local(let id, let compose): c.host = "local"; c.path = "/\(id)"; if compose { c.queryItems = [.init(name: "compose", value: "1")] }
        case .agent(let id, let compose): c.host = "agents"; c.path = "/\(id)"; if compose { c.queryItems = [.init(name: "compose", value: "1")] }
        case .session(let id): c.host = "sessions"; c.path = "/\(id)"
        case .needsYou: c.host = "needs-you"
        case .section(let name): c.host = "section"; c.path = "/\(name)"
        }
        return c.url!
    }

    public init?(url: URL) {
        guard url.scheme == Self.scheme, let host = url.host else { return nil }
        let id = url.pathComponents.dropFirst().first
        let compose = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains { $0.name == "compose" && $0.value == "1" } ?? false
        switch (host, id) {
        case ("tasks", let id?): self = .task(id)
        case ("local", let id?): self = .local(id, compose: compose)
        case ("agents", let id?): self = .agent(id, compose: compose)
        case ("sessions", let id?): self = .session(id)
        case ("needs-you", _): self = .needsYou
        case ("section", let name?): self = .section(name)
        default: return nil
        }
    }
}
