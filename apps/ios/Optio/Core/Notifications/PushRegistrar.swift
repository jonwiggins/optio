import Foundation
import Observation
import UIKit
import UserNotifications

/// Owns notification authorization and APNs device-token registration.
///
/// Rules (product brief §2i, architecture §2):
/// - Never prompt on first launch. The system prompt is shown the first time a
///   `needs_you` is observed while the app is open, or from Settings.
/// - Without the `aps-environment` entitlement (free team, simulator) the token
///   request fails; that is a *state* ("Push needs a signed build"), not an error.
/// - The device is POSTed to `/api/notifications/devices`; a 404 there means the
///   server predates APNs support and is tolerated.
@MainActor
@Observable
final class PushRegistrar {
    static let shared = PushRegistrar()

    enum Registration: Equatable {
        /// Nothing attempted yet (not authorized, or app just launched).
        case idle
        /// `registerForRemoteNotifications` called; waiting for the token callback.
        case waitingForToken
        /// APNs issued a token and the server accepted it.
        case registered
        /// APNs issued a token but the server has no device registry yet (404) or was unreachable.
        case tokenOnly(reason: String)
        /// `didFailToRegisterForRemoteNotifications`: no push entitlement on this build.
        case needsSignedBuild
    }

    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    private(set) var registration: Registration = .idle
    /// Hex APNs token of this device, when APNs issued one.
    private(set) var deviceToken: String?
    private(set) var lastServerError: String?

    private weak var session: SessionStore?
    private var eventToken: EventHub.Subscription?
    private var lastKnownPhase: SessionStore.Phase?
    /// Base URL + PAT used for the last successful POST, so sign-out can still DELETE.
    private var registeredWith: (baseURL: URL, token: String)?
    private var promptedForNeedsYou = false

    private enum Keys {
        static let deviceToken = "optio.push.deviceToken"
        static let promptedOnce = "optio.push.promptedOnce"
    }

    private init() {
        deviceToken = UserDefaults.standard.string(forKey: Keys.deviceToken)
    }

    // MARK: - Wiring

    /// Called once from `OptioApp`. Observes the session so registration follows
    /// sign-in/out, and watches the event hub for the first `needs_you`.
    func attach(session: SessionStore) {
        self.session = session
        IntentContext.session = session
        observePhase()
        Task { await refreshAuthorization() }
    }

    private func observePhase() {
        guard let session else { return }
        withObservationTracking {
            _ = session.phase
        } onChange: {
            Task { @MainActor [weak self] in
                self?.phaseDidChange()
                self?.observePhase()
            }
        }
        phaseDidChange()
    }

    private func phaseDidChange() {
        guard let session else { return }
        let phase = session.phase
        guard phase != lastKnownPhase else { return }
        lastKnownPhase = phase
        switch phase {
        case .signedIn:
            subscribeToEvents()
            Task {
                await refreshAuthorization()
                registerIfAuthorized()
                await syncDeviceIfPossible()
                NotificationHandler.shared.flushPendingURL()
            }
        case .signedOut:
            eventToken = nil
            Task { await unregisterFromServer() }
        case .restoring:
            break
        }
    }

    private func subscribeToEvents() {
        guard let session, eventToken == nil else { return }
        let api = session.api
        eventToken = session.events.subscribe { [weak self] event in
            guard let self else { return }
            switch event {
            case .taskStateChanged(let e) where e.toState == .needsAttention:
                self.noteNeedsYouObserved()
            case .unknown(let payload):
                // `local:changed` is a content-free nudge; look up whether anything needs us.
                if case .object(let obj) = payload, obj["type"]?.stringValue == "local:changed" {
                    Task { [weak self] in
                        guard let self, self.authorization == .notDetermined, !self.promptedForNeedsYou else { return }
                        if let terms = try? await api.listLocalTerminals(state: "running"),
                           terms.contains(where: { $0.attentionState == .needsYou }) {
                            self.noteNeedsYouObserved()
                        }
                    }
                }
            default:
                break
            }
        }
    }

    // MARK: - Authorization

    func refreshAuthorization() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorization = settings.authorizationStatus
    }

    var isAuthorized: Bool {
        switch authorization {
        case .authorized, .provisional, .ephemeral: return true
        case .denied, .notDetermined: return false
        @unknown default: return false
        }
    }

    /// Explicit prompt. Safe to call repeatedly; the system only shows the sheet once.
    @discardableResult
    func requestAuthorization() async -> Bool {
        UserDefaults.standard.set(true, forKey: Keys.promptedOnce)
        NotificationCategory.register()
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        await refreshAuthorization()
        if granted { registerIfAuthorized() }
        return granted
    }

    /// First `needs_you` seen while the app is open: the moment the prompt makes sense.
    func noteNeedsYouObserved() {
        guard authorization == .notDetermined, !promptedForNeedsYou,
              !UserDefaults.standard.bool(forKey: Keys.promptedOnce) else { return }
        promptedForNeedsYou = true
        Task { await requestAuthorization() }
    }

    // MARK: - APNs registration

    func registerIfAuthorized() {
        guard isAuthorized else { return }
        NotificationCategory.register()
        if registration == .idle || registration == .needsSignedBuild {
            registration = .waitingForToken
        }
        UIApplication.shared.registerForRemoteNotifications()
    }

    func didRegister(deviceToken data: Data) {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        deviceToken = hex
        UserDefaults.standard.set(hex, forKey: Keys.deviceToken)
        Task { await syncDeviceIfPossible() }
    }

    func didFailToRegister(error: Error) {
        // Free personal teams and simulators without a provisioning profile land
        // here ("no valid aps-environment entitlement"). Friendly state, no alert.
        registration = .needsSignedBuild
        lastServerError = nil
    }

    /// `sandbox` for Xcode/DEBUG/simulator builds, `production` for App Store /
    /// TestFlight builds (the embedded profile carries `aps-environment=production`).
    static var apnsEnvironment: String {
        #if targetEnvironment(simulator)
        return "sandbox"
        #else
        #if DEBUG
        return "sandbox"
        #else
        if let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
           let data = try? Data(contentsOf: url),
           let text = String(data: data, encoding: .isoLatin1),
           let range = text.range(of: "<key>aps-environment</key>") {
            let tail = text[range.upperBound...].prefix(80)
            if tail.contains("development") { return "sandbox" }
        }
        return "production"
        #endif
        #endif
    }

    // MARK: - Server sync

    struct DeviceRegistration: Encodable {
        var token: String
        var platform = "ios"
        var environment: String
        var bundleId: String
        var appVersion: String
        var deviceName: String
    }

    static var currentRegistration: DeviceRegistration? {
        guard let token = PushRegistrar.shared.deviceToken else { return nil }
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        return DeviceRegistration(
            token: token,
            environment: apnsEnvironment,
            bundleId: Bundle.main.bundleIdentifier ?? "dev.optio.ios",
            appVersion: "\(v) (\(b))",
            deviceName: UIDevice.current.name)
    }

    func syncDeviceIfPossible() async {
        guard let session, session.phase == .signedIn, session.api.isConfigured,
              let body = Self.currentRegistration else { return }
        let api = session.api
        do {
            try await api.post("/api/notifications/devices", body: body)
            registration = .registered
            lastServerError = nil
            if let base = api.baseURL, let tok = api.token { registeredWith = (base, tok) }
        } catch let error as APIError where error.status == 404 {
            registration = .tokenOnly(reason: "The server doesn't have a device registry yet — update Optio.")
            lastServerError = nil
        } catch {
            registration = .tokenOnly(reason: "Couldn't reach the server to register this device.")
            lastServerError = error.localizedDescription
        }
    }

    /// `DELETE /api/notifications/devices/:token` with the credentials that
    /// registered it (the session may already be cleared by the time we run).
    func unregisterFromServer() async {
        defer {
            registeredWith = nil
            if registration == .registered { registration = .idle }
        }
        guard let token = deviceToken, let creds = registeredWith else { return }
        var req = URLRequest(url: creds.baseURL.appending(path: "/api/notifications/devices/\(token)"))
        req.httpMethod = "DELETE"
        req.timeoutInterval = 10
        req.setValue("Bearer \(creds.token)", forHTTPHeaderField: "Authorization")
        _ = try? await URLSession.shared.data(for: req)
    }

    /// Masked token for the Settings screen: first 6 and last 4 hex chars.
    var maskedToken: String? {
        guard let t = deviceToken, t.count > 12 else { return deviceToken }
        return "\(t.prefix(6))…\(t.suffix(4))"
    }
}
