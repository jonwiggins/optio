import Foundation

/// Widget/control kind identifiers, kept off the `@MainActor`-isolated `Widget` types so
/// intents can reload timelines from any context.
enum WidgetKinds {
    /// The Sessions widget (formerly "Agents", before that "Needs You" + "In Flight"); the
    /// id is kept so widgets already placed on a home screen survive each rename.
    static let sessions = "dev.optio.ios.needs-you"
    /// The Start widget (formerly "Run"): fires one recurring session with a tap.
    static let run = "dev.optio.ios.run"
    static let needsYouControl = "dev.optio.ios.control.needs-you"
    static let runControl = "dev.optio.ios.control.run"
    static let newSessionControl = "dev.optio.ios.control.new-session"
}
