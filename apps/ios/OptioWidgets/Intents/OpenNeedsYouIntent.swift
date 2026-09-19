import AppIntents
import Foundation

/// (iOS 18: `OpenURLIntent`.) Opens the app at the oldest session needing you (`optio://needs-you`,
/// the Sessions list in its Active view). Used by the "Jump to what needs me" control.
@available(iOS 18, *)
struct OpenNeedsYouIntent: AppIntent {
    static let title: LocalizedStringResource = "Jump to what needs me"
    static let description = IntentDescription("Open Optio at the oldest session waiting on you.")
    static let openAppWhenRun = true

    init() {}

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(DeepLink.needsYou.url))
    }
}
