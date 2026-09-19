import SwiftUI
import WidgetKit

@main
struct OptioWidgetsBundle: WidgetBundle {
    var body: some Widget {
        SessionsWidget()
        RunWidget()
        WatchLiveActivity()
        if #available(iOS 18, *) {
            NeedsYouControl()
            NewSessionControl()
            RunTargetControl()
        }
    }
}
