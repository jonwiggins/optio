import Foundation

/// Widget/control kind identifiers, kept off the `@MainActor`-isolated `Widget` types so
/// intents can reload timelines from any context.
enum WidgetKinds {
    static let needsYou = "dev.optio.ios.needs-you"
    static let inFlight = "dev.optio.ios.in-flight"
    static let run = "dev.optio.ios.run"
    static let needsYouControl = "dev.optio.ios.control.needs-you"
    static let runControl = "dev.optio.ios.control.run"
}
