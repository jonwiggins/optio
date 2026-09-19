import AppIntents
import SwiftUI
import WidgetKit

/// Control Center: "New session". One tap opens the app at the New session sheet —
/// the one way in for a PR, a chat on your machine, a schedule, or a persistent agent.
/// Static: no state to read, so it never touches the network.
@available(iOS 18, *)
struct NewSessionControl: ControlWidget {
    static let kind = WidgetKinds.newSessionControl

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: OpenNewSessionIntent()) {
                Label {
                    Text("New session")
                    Text(SharedCredentials.isConfigured ? "When · Where · Who · What" : "Sign in to Optio")
                } icon: {
                    Image(systemName: "plus.rectangle.on.rectangle")
                }
            }
            .tint(StatusColor.purple)
        }
        .displayName("New session")
        .description("Start a session: a PR, a chat on your machine, a schedule, or an agent.")
    }
}
