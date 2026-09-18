import AppIntents
import Foundation

/// App Intents run inside the app process, so they can use the signed-in
/// session's `APIClient`. `OptioApp` attaches the session once at launch.
@MainActor
enum IntentContext {
    weak static var session: SessionStore?

    /// The configured client, or a Siri-readable error when signed out.
    static func api() throws -> APIClient {
        guard let session, session.api.isConfigured else { throw IntentFailure.signedOut }
        return session.api
    }
}

enum IntentFailure: Error, CustomLocalizedStringResourceConvertible {
    case signedOut
    case notFound(String)
    case server(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .signedOut: return "Open Optio and sign in first."
        case .notFound(let what): return "Couldn't find \(what)."
        case .server(let msg): return "Optio said: \(msg)"
        }
    }
}

extension Error {
    var intentFailure: IntentFailure {
        if let f = self as? IntentFailure { return f }
        if let api = self as? APIError { return .server(api.message) }
        return .server(localizedDescription)
    }
}

/// Joins names the way Siri reads them: "web-ui", "web-ui and api", "web-ui, api and docs".
func siriList(_ names: [String]) -> String {
    switch names.count {
    case 0: return ""
    case 1: return names[0]
    case 2: return "\(names[0]) and \(names[1])"
    default: return names.dropLast().joined(separator: ", ") + " and " + names.last!
    }
}

extension LocalTerminal {
    /// Terminals running an agent (the only ones with attention hooks).
    var isAgentTerminal: Bool {
        if case .agent = spec { return true }
        return false
    }
}
