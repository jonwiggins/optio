import SwiftUI
import UIKit
import UserNotifications

/// Notifications on this iPhone: system authorization, APNs registration state,
/// this device's token, the user's registered devices, and a link to the
/// per-event preference toggles.
struct NotificationsDevicesView: View {
    @Environment(APIClient.self) private var api
    @Environment(\.scenePhase) private var scenePhase

    @State private var registrar = PushRegistrar.shared
    @State private var devices: [DeviceRow] = []
    @State private var devicesState: DevicesState = .loading
    @State private var requesting = false
    @State private var errorMessage: String?

    enum DevicesState: Equatable { case loading, loaded, unsupported, failed(String) }

    struct DeviceRow: Decodable, Identifiable, Hashable {
        var id: String { token }
        let token: String
        let platform: String?
        let environment: String?
        let deviceName: String?
        let appVersion: String?
        let createdAt: Date?
        let lastSeenAt: Date?

        private enum CodingKeys: String, CodingKey {
            case token, deviceToken, platform, environment, bundleEnv, deviceName, appVersion, createdAt, lastSeenAt
        }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            token = try c.decodeIfPresent(String.self, forKey: .token) ?? c.decode(String.self, forKey: .deviceToken)
            platform = try c.decodeIfPresent(String.self, forKey: .platform)
            environment = try c.decodeIfPresent(String.self, forKey: .environment) ?? c.decodeIfPresent(String.self, forKey: .bundleEnv)
            deviceName = try c.decodeIfPresent(String.self, forKey: .deviceName)
            appVersion = try c.decodeIfPresent(String.self, forKey: .appVersion)
            createdAt = try? c.decodeIfPresent(Date.self, forKey: .createdAt)
            lastSeenAt = try? c.decodeIfPresent(Date.self, forKey: .lastSeenAt)
        }

        var masked: String {
            token.count > 12 ? "\(token.prefix(6))…\(token.suffix(4))" : token
        }
    }

    var body: some View {
        List {
            authorizationSection
            registrationSection
            devicesSection
            Section {
                NavigationLink { NotificationPreferencesView() } label: {
                    Label("What to notify me about", systemImage: "list.bullet")
                }
            } footer: {
                Text("Per-event toggles are shared with your browser subscriptions.")
            }
        }
        .navigationTitle("This iPhone")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await registrar.refreshAuthorization()
            await loadDevices()
        }
        .refreshable {
            await registrar.refreshAuthorization()
            await registrar.syncDeviceIfPossible()
            await loadDevices()
        }
        .onChange(of: scenePhase) { _, phase in
            // Coming back from Settings.app after flipping the switch.
            if phase == .active { Task { await registrar.refreshAuthorization(); registrar.registerIfAuthorized() } }
        }
        .moreErrorAlert($errorMessage)
    }

    // MARK: - Sections

    @ViewBuilder private var authorizationSection: some View {
        Section {
            HStack {
                Image(systemName: authIcon).foregroundStyle(authColor)
                Text(authLabel)
                Spacer()
            }
            switch registrar.authorization {
            case .notDetermined:
                Button {
                    Task {
                        requesting = true
                        defer { requesting = false }
                        await registrar.requestAuthorization()
                    }
                } label: {
                    if requesting { ProgressView() } else { Label("Enable notifications", systemImage: "bell.badge") }
                }
                .disabled(requesting)
            case .denied:
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                } label: {
                    Label("Open iPhone Settings", systemImage: "gear")
                }
            default:
                EmptyView()
            }
        } header: {
            Text("Alerts")
        } footer: {
            Text("Optio only alerts when something needs you: a terminal waiting on a reply, a task that stalled, an agent that answered. Working and idle are silent.")
        }
    }

    @ViewBuilder private var registrationSection: some View {
        Section {
            HStack {
                Image(systemName: registrationIcon).foregroundStyle(registrationColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text(registrationLabel)
                    if let detail = registrationDetail {
                        Text(detail).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if let masked = registrar.maskedToken {
                MoreInfoRow(label: "Token", value: masked, mono: true)
            }
            MoreInfoRow(label: "Environment", value: PushRegistrar.apnsEnvironment, mono: true)
            if case .tokenOnly = registrar.registration {
                Button {
                    Task { await registrar.syncDeviceIfPossible(); await loadDevices() }
                } label: {
                    Label("Retry registration", systemImage: "arrow.clockwise")
                }
            }
        } header: {
            Text("Push delivery")
        } footer: {
            if registrar.registration == .needsSignedBuild {
                Text("Banners need a build signed by an Apple Developer team. Everything else — widgets, the Watch, Siri — works without it.")
            }
        }
    }

    @ViewBuilder private var devicesSection: some View {
        Section {
            switch devicesState {
            case .loading:
                ProgressView().frame(maxWidth: .infinity)
            case .unsupported:
                Text("This server doesn't register devices yet.").foregroundStyle(.secondary).font(.footnote)
            case .failed(let msg):
                Label(msg, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.secondary)
            case .loaded:
                if devices.isEmpty {
                    Text("No devices registered.").foregroundStyle(.secondary).font(.footnote)
                }
                ForEach(devices) { d in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(d.deviceName ?? "Unnamed device")
                            if d.token == registrar.deviceToken {
                                Text("this iPhone").font(.caption2).padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(AppTheme.accent.opacity(0.15), in: Capsule()).foregroundStyle(AppTheme.accent)
                            }
                        }
                        HStack(spacing: 6) {
                            Text(d.masked).font(.caption.monospaced())
                            if let env = d.environment { Text("· \(env)").font(.caption) }
                            if let v = d.appVersion { Text("· \(v)").font(.caption) }
                        }
                        .foregroundStyle(.secondary)
                        if let seen = d.lastSeenAt {
                            Text("Last seen \(seen.relativeDescription)").font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                    .swipeActions {
                        Button(role: .destructive) { Task { await remove(d) } } label: { Label("Remove", systemImage: "trash") }
                    }
                }
            }
        } header: {
            Text("Your devices")
        }
    }

    // MARK: - Labels

    private var authLabel: String {
        switch registrar.authorization {
        case .authorized: return "Notifications allowed"
        case .provisional: return "Delivered quietly"
        case .ephemeral: return "Allowed for this App Clip"
        case .denied: return "Notifications off"
        case .notDetermined: return "Not asked yet"
        @unknown default: return "Unknown"
        }
    }

    private var authIcon: String {
        switch registrar.authorization {
        case .authorized, .provisional, .ephemeral: return "bell.fill"
        case .denied: return "bell.slash"
        default: return "bell"
        }
    }

    private var authColor: Color {
        switch registrar.authorization {
        case .authorized, .provisional, .ephemeral: return AppTheme.accent
        case .denied: return .red
        default: return .secondary
        }
    }

    private var registrationLabel: String {
        switch registrar.registration {
        case .idle: return registrar.isAuthorized ? "Not registered yet" : "Waiting for permission"
        case .waitingForToken: return "Asking Apple for a token…"
        case .registered: return "Registered with your Optio server"
        case .tokenOnly: return "Token issued, not on the server"
        case .needsSignedBuild: return "Push needs a signed build"
        }
    }

    private var registrationDetail: String? {
        switch registrar.registration {
        case .tokenOnly(let reason): return reason
        case .needsSignedBuild: return "No push entitlement in this build."
        default: return registrar.lastServerError
        }
    }

    private var registrationIcon: String {
        switch registrar.registration {
        case .registered: return "checkmark.seal.fill"
        case .needsSignedBuild: return "signature"
        case .tokenOnly: return "exclamationmark.circle"
        case .waitingForToken: return "hourglass"
        case .idle: return "circle.dashed"
        }
    }

    private var registrationColor: Color {
        switch registrar.registration {
        case .registered: return .green
        case .tokenOnly: return .secondary
        default: return .secondary
        }
    }

    // MARK: - Data

    private func loadDevices() async {
        struct R: Decodable { let devices: [DeviceRow] }
        do {
            devices = try await api.get("/api/notifications/devices", as: R.self).devices
            devicesState = .loaded
        } catch let error as APIError where error.status == 404 {
            devicesState = .unsupported
        } catch {
            devicesState = .failed(error.moreDescription)
        }
    }

    private func remove(_ d: DeviceRow) async {
        do {
            try await api.delete("/api/notifications/devices/\(d.token)")
            devices.removeAll { $0.token == d.token }
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
