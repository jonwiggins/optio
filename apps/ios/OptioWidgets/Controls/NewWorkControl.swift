import AppIntents
import SwiftUI
import WidgetKit

/// Control Center: "New work". One tap opens the app at the New work sheet —
/// the one way in for a PR, a chat on your machine, a schedule, or a persistent agent.
/// Static: no state to read, so it never touches the network.
@available(iOS 18, *)
struct NewWorkControl: ControlWidget {
    static let kind = WidgetKinds.newSessionControl

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: OpenNewWorkIntent()) {
                Label {
                    Text("New work")
                    Text(SharedCredentials.isConfigured ? "When · Where · Who · What" : "Sign in to Optio")
                } icon: {
                    Image(systemName: "plus.rectangle.on.rectangle")
                }
            }
            .tint(StatusColor.purple)
        }
        .displayName("New work")
        .description("Start work: a PR, a chat on your machine, a schedule, or an agent.")
    }
}
