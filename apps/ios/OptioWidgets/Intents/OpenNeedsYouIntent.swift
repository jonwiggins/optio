import AppIntents
import Foundation

/// (iOS 18: `OpenURLIntent`.) Opens the app at the oldest needs-you item (`optio://needs-you`). Used by the
/// "Jump to what needs me" control.
@available(iOS 18, *)
struct OpenNeedsYouIntent: AppIntent {
    static let title: LocalizedStringResource = "Jump to what needs me"
    static let description = IntentDescription("Open Optio at the oldest item waiting on you.")
    static let openAppWhenRun = true

    init() {}

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(DeepLink.needsYou.url))
    }
}
