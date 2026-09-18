import AppIntents
import SwiftUI
import WidgetKit

/// Control Center: "Jump to what needs me". Opens the app at the oldest needs-you item;
/// reads the cached snapshot so it can say "Quiet" without a network call.
@available(iOS 18, *)
struct NeedsYouControl: ControlWidget {
    static let kind = WidgetKinds.needsYouControl

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind, provider: NeedsYouControlProvider()) { value in
            ControlWidgetButton(action: OpenNeedsYouIntent()) {
                Label {
                    if value.signedOut {
                        Text("Sign in to Optio")
                    } else if value.count > 0 {
                        Text("Jump to what needs me")
                        if let path = value.path { Text(path) }
                    } else {
                        Text("Quiet")
                        Text("Nothing needs you")
                    }
                } icon: {
                    Image(systemName: value.count > 0 ? GlanceStyle.glyph : "moon")
                }
            }
            .tint(value.count > 0 ? GlanceStyle.purple : .secondary)
        }
        .displayName("Jump to what needs me")
        .description("Open Optio at the oldest item waiting on you.")
    }
}

@available(iOS 18, *)
struct NeedsYouControlValue {
    var count: Int
    var path: String?
    var signedOut: Bool
}

@available(iOS 18, *)
struct NeedsYouControlProvider: ControlValueProvider {
    var previewValue: NeedsYouControlValue { NeedsYouControlValue(count: 2, path: "optio/apps/web", signedOut: false) }

    func currentValue() async throws -> NeedsYouControlValue {
        guard SharedCredentials.isConfigured else { return NeedsYouControlValue(count: 0, path: nil, signedOut: true) }
        let cached = GlanceStore.cachedSnapshot.map { GlanceTimelineProvider.ordered($0, now: .now) }
        return NeedsYouControlValue(count: cached?.needsYou.count ?? 0, path: cached?.needsYou.first?.mono, signedOut: false)
    }
}
