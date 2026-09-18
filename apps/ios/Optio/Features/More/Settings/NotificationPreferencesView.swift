import SwiftUI

/// Per-event notification toggles (`/api/notifications/preferences`). The
/// server only delivers web push today; there is no APNs path yet, so these
/// preferences affect browser subscriptions, not this device.
struct NotificationPreferencesView: View {
    @Environment(APIClient.self) private var api
    @State private var prefs: [String: NotificationPref] = [:]
    @State private var loaded = false
    @State private var loadError: Error?
    @State private var errorMessage: String?

    private static let events: [(String, String, String)] = [
        ("task.pr_opened", "PR opened", "When a task you created opens a pull request"),
        ("task.completed", "Task completed", "When your task merges successfully"),
        ("task.failed", "Task failed", "When your task fails"),
        ("task.needs_attention", "Needs attention", "When a task needs your input (review changes, CI failing, etc.)"),
        ("task.stalled", "Task stalled", "When a task appears to be stuck"),
        ("task.review_requested", "Review requested", "When someone requests a review on your PR"),
        ("task.commented", "New comment", "When someone comments on your task"),
    ]

    var body: some View {
        List {
            Section {
                Label {
                    Text("Push delivery to this iPhone is not available yet — Optio's server only sends browser (web push) notifications. These toggles control what gets pushed to your subscribed browsers.")
                } icon: {
                    Image(systemName: "info.circle")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            if loaded {
                Section("Notification events") {
                    ForEach(Self.events, id: \.0) { ev in
                        Toggle(isOn: Binding(
                            get: { prefs[ev.0]?.push ?? false },
                            set: { on in Task { await set(ev.0, on) } }
                        )) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(ev.1)
                                Text(ev.2).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } else if let loadError {
                ErrorBanner(error: loadError) { Task { await load() } }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .moreErrorAlert($errorMessage)
    }

    private func load() async {
        do {
            prefs = try await api.getNotificationPreferences()
            loaded = true
            loadError = nil
        } catch {
            loadError = error
        }
    }

    private func set(_ event: String, _ on: Bool) async {
        let previous = prefs[event]
        prefs[event] = NotificationPref(push: on)
        do {
            prefs = try await api.updateNotificationPreferences([event: NotificationPref(push: on)])
        } catch {
            prefs[event] = previous
            errorMessage = error.moreDescription
        }
    }
}
