import SwiftUI
import WidgetKit

@main
struct OptioWidgetsBundle: WidgetBundle {
    var body: some Widget {
        NeedsYouWidget()
        InFlightWidget()
        RunWidget()
        WatchLiveActivity()
        if #available(iOS 18, *) {
            NeedsYouControl()
            RunTargetControl()
        }
    }
}
