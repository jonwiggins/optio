import AppIntents
import SwiftUI
import WidgetKit

/// Control Center: "Run ⟨blueprint⟩". Configurable, fires `RunTargetIntent` without
/// confirmation (Control Center is already a deliberate gesture), checkmark for ~3 s.
@available(iOS 18, *)
struct RunTargetControl: ControlWidget {
    static let kind = WidgetKinds.runControl

    var body: some ControlWidgetConfiguration {
        AppIntentControlConfiguration(kind: Self.kind, provider: RunControlProvider()) { value in
            ControlWidgetButton(action: RunTargetIntent(target: value.target, confirm: false)) {
                Label {
                    Text(value.target.map { "Run \($0.name)" } ?? "Run")
                    if value.justStarted {
                        Text("Started")
                    } else if value.target == nil {
                        Text("Choose a blueprint")
                    }
                } icon: {
                    Image(systemName: value.justStarted ? "checkmark" : "play.fill")
                }
            }
        }
        .displayName("Run blueprint")
        .description("Start a blueprint or Job.")
    }
}

@available(iOS 18, *)
struct RunControlValue {
    var target: RunTargetEntity?
    var justStarted: Bool
}

@available(iOS 18, *)
struct RunControlProvider: AppIntentControlValueProvider {
    func previewValue(configuration: RunControlConfigurationIntent) -> RunControlValue {
        RunControlValue(target: configuration.target ?? RunFixtures.nightly, justStarted: false)
    }

    func currentValue(configuration: RunControlConfigurationIntent) async throws -> RunControlValue {
        let started = configuration.target.flatMap { GlanceStore.startedAt($0.id) }
        let recent = started.map { Date.now.timeIntervalSince($0) < 3.5 } ?? false
        return RunControlValue(target: configuration.target, justStarted: recent)
    }
}
