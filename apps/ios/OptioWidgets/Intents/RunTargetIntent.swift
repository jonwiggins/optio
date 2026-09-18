import AppIntents
import Foundation
import WidgetKit

/// Fires a Local blueprint or a Job from the Run widget or control, in the extension
/// (no app launch). With `confirm`, the first tap only arms the widget for ten seconds
/// ("Tap again to run"); the second tap fires. WidgetKit has no confirmation dialog for
/// interactive widgets, so two taps is the honest equivalent.
struct RunTargetIntent: AppIntent {
    static let title: LocalizedStringResource = "Run Optio Blueprint"
    static let description = IntentDescription("Start a Local blueprint or a Job.")

    @Parameter(title: "Blueprint") var target: RunTargetEntity?
    @Parameter(title: "Ask before running", default: true) var confirm: Bool

    init() {}
    init(target: RunTargetEntity?, confirm: Bool) {
        self.target = target
        self.confirm = confirm
    }

    static var parameterSummary: some ParameterSummary {
        Summary("Run \(\.$target)") { \.$confirm }
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let target, let path = target.firePath else {
            return .result(dialog: "Choose a blueprint in the widget's settings.")
        }
        let now = Date.now
        if confirm, !GlancePolicy.isArmed(armedAt: GlanceStore.armedAt(target.id), now: now) {
            GlanceStore.setArmed(target.id, at: now)
            WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.run)
            return .result(dialog: "Tap again to run \(target.name).")
        }
        GlanceStore.setArmed(target.id, at: nil)
        guard let fetch = SharedFetch.resolve(target.serverId) else { return .result(dialog: "Sign in to Optio first.") }
        do {
            try await fetch.post(path, json: [:], timeout: 15)
        } catch {
            WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.run)
            return .result(dialog: "Couldn't start \(target.name).")
        }
        GlanceStore.setStarted(target.id, at: .now)
        WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.run)
        if #available(iOS 18, *) {
            ControlCenter.shared.reloadControls(ofKind: WidgetKinds.runControl)
            // Checkmark for ~3 s, then back to the plain label.
            try? await Task.sleep(for: .seconds(3))
            ControlCenter.shared.reloadControls(ofKind: WidgetKinds.runControl)
        }
        return .result(dialog: "Started \(target.name).")
    }
}

/// Widget configuration: which target, and whether to ask first.
struct RunConfigurationIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Run"
    static let description = IntentDescription("Pick the blueprint or Job this widget starts.")

    @Parameter(title: "Blueprint") var target: RunTargetEntity?
    @Parameter(title: "Ask before running", default: true) var confirm: Bool

    init() {}
    init(target: RunTargetEntity?, confirm: Bool = true) {
        self.target = target
        self.confirm = confirm
    }
}

/// Control configuration (iOS 18): the same shape, as a `ControlConfigurationIntent`.
@available(iOS 18, *)
struct RunControlConfigurationIntent: ControlConfigurationIntent {
    static let title: LocalizedStringResource = "Run"
    static let description = IntentDescription("Pick the blueprint or Job this control starts.")

    @Parameter(title: "Blueprint") var target: RunTargetEntity?

    init() {}
    init(target: RunTargetEntity?) { self.target = target }
}
