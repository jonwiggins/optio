import SwiftUI
import WidgetKit

/// WidgetConfiguration and WidgetBundleBuilder cannot select between two
/// configurations with an if/else. Choose the bundle at the entry point so iOS 17
/// keeps its Live Activity and newer systems register exactly one Watch-aware one.
@main
enum OptioWidgetsEntry {
    static func main() {
        if #available(iOS 18.0, *) {
            OptioWidgetsBundle.main()
        } else {
            LegacyOptioWidgetsBundle.main()
        }
    }
}

@available(iOS 18.0, *)
struct OptioWidgetsBundle: WidgetBundle {
    var body: some Widget {
        WorkWidget()
        RunWidget()
        WatchLiveActivity()
        NeedsYouControl()
        NewWorkControl()
        RunTargetControl()
    }
}

struct LegacyOptioWidgetsBundle: WidgetBundle {
    var body: some Widget {
        WorkWidget()
        RunWidget()
        LegacyWatchLiveActivity()
    }
}
