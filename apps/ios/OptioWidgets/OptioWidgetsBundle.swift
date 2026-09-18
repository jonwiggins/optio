import SwiftUI
import WidgetKit

@main
struct OptioWidgetsBundle: WidgetBundle {
    var body: some Widget {
        AgentsWidget()
        RunWidget()
        WatchLiveActivity()
        if #available(iOS 18, *) {
            NeedsYouControl()
            RunTargetControl()
        }
    }
}
