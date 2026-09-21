import SwiftUI
import WidgetKit

@main
struct OptioWidgetsBundle: WidgetBundle {
    var body: some Widget {
        WorkWidget()
        RunWidget()
        WatchLiveActivity()
        if #available(iOS 18, *) {
            NeedsYouControl()
            NewWorkControl()
            RunTargetControl()
        }
    }
}
