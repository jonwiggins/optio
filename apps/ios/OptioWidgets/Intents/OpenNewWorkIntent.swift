import AppIntents
import Foundation

/// (iOS 18: `OpenURLIntent`.) Opens the app at the New session sheet (`optio://sessions/new`).
/// Used by the "New session" control; also discoverable in Shortcuts.
@available(iOS 18, *)
struct OpenNewWorkIntent: AppIntent {
    static let title: LocalizedStringResource = "New session"
    static let description = IntentDescription("Open Optio at the New session form: When · Where · Who · What · Then.")
    static let openAppWhenRun = true

    init() {}

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(DeepLink.newWork.url))
    }
}
