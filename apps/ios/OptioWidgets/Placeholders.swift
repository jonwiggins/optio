// PLACEHOLDER — replaced by the widgets and Live Activity agents. Keeps the extension compiling.
import ActivityKit
import SwiftUI
import WidgetKit

struct NeedsYouWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "dev.optio.ios.needs-you", provider: PlaceholderProvider()) { _ in
            Text("Optio").containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Needs You")
        .description("What's waiting on you.")
        .supportedFamilies([.systemSmall])
    }
}

struct PlaceholderProvider: TimelineProvider {
    struct Entry: TimelineEntry { let date: Date }
    func placeholder(in context: Context) -> Entry { Entry(date: .now) }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(Entry(date: .now)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        completion(Timeline(entries: [Entry(date: .now)], policy: .after(.now.addingTimeInterval(900))))
    }
}

struct WatchLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: WatchAttributes.self) { context in
            Text(context.state.phase.rawValue)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.center) { Text(context.state.phase.rawValue) }
            } compactLeading: { Text("O") } compactTrailing: { Text("\(context.state.needsYouCount)") } minimal: { Text("O") }
        }
    }
}
