import Foundation

/// Widget/control kind identifiers, kept off the `@MainActor`-isolated `Widget` types so
/// intents can reload timelines from any context.
enum WidgetKinds {
    /// The Agents widget (formerly "Needs You" + "In Flight"); the id is kept so placed widgets survive.
    static let agents = "dev.optio.ios.needs-you"
    static let run = "dev.optio.ios.run"
    static let needsYouControl = "dev.optio.ios.control.needs-you"
    static let runControl = "dev.optio.ios.control.run"
}
