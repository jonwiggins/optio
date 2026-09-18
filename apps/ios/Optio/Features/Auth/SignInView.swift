import SwiftUI

/// First-run screen: pair this phone with your Optio server.
///
/// Reads as a device pairing, not a SaaS login: identity block, the host in mono,
/// a token, one Connect button. Errors say precisely what failed.
struct SignInView: View {
    @Environment(SessionStore.self) private var session
    @State private var serverURL = UserDefaults.standard.string(forKey: "optio.lastServerURL") ?? ""
    @State private var token = ""
    @State private var busy = false
    @State private var error: SignInError?
    @State private var showHelp = false
    @FocusState private var focus: Field?

    private enum Field { case server, token }

    enum SignInError: Equatable {
        case badURL, unreachable(String), rejected, other(String)

        var message: String {
            switch self {
            case .badURL: return "Enter the server address, including the port if it isn't 443."
            case .unreachable(let host): return "Couldn't reach \(host). Check the address and that this phone is on the same Tailscale network."
            case .rejected: return "The server rejected that token. Create a new one in the web app under Settings › API keys."
            case .other(let m): return m
            }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                identity
                    .padding(.top, 56)
                    .padding(.bottom, 40)

                field("Server", systemImage: "network") {
                    TextField("laptop.tailnet.ts.net", text: $serverURL)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                        .focused($focus, equals: .server)
                        .submitLabel(.next)
                        .onSubmit { focus = .token }
                }
                .padding(.bottom, 14)

                field("Token", systemImage: "key") {
                    SecureField("optio_pat_…", text: $token)
                        .textContentType(.password)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                        .focused($focus, equals: .token)
                        .submitLabel(.go)
                        .onSubmit { Task { await submit() } }
                }

                if let error {
                    Text(error.message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .padding(.top, 10)
                        .transition(.opacity)
                }

                Button {
                    Task { await submit() }
                } label: {
                    HStack(spacing: 8) {
                        if busy { ProgressView().tint(.white) }
                        Text(busy ? "Connecting to \(hostLabel)…" : "Connect")
                            .fontWeight(.semibold)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(busy || !canSubmit)
                .padding(.top, 24)

                help
                    .padding(.top, 28)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 40)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color(.systemBackground))
        .animation(.easeOut(duration: 0.2), value: error)
        .onAppear { if serverURL.isEmpty { focus = .server } }
    }

    // MARK: - Pieces

    private var identity: some View {
        VStack(alignment: .leading, spacing: 18) {
            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(AppTheme.accent.opacity(0.14))
                BotGlyph()
                    .stroke(AppTheme.accent, style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                    .padding(17)
            }
            .frame(width: 72, height: 72)

            VStack(alignment: .leading, spacing: 6) {
                Text("Optio")
                    .font(.system(size: 40, weight: .bold))
                    .tracking(-1)
                Text("Remote control for your agents.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func field<Content: View>(_ label: String, systemImage: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(label, systemImage: systemImage)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            content()
                .padding(.horizontal, 14)
                .padding(.vertical, 13)
                .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private var help: some View {
        DisclosureGroup(isExpanded: $showHelp) {
            VStack(alignment: .leading, spacing: 10) {
                helpRow("On Tailscale, the address is your Mac's name, like", code: "https://laptop.tailnet.ts.net")
                helpRow("Tokens come from the web app under Settings › API keys, or from", code: "optio login")
                helpRow("Local dev with auth disabled accepts any token.", code: nil)
            }
            .padding(.top, 10)
        } label: {
            Text("Where do I get these?")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .tint(.secondary)
    }

    private func helpRow(_ text: String, code: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(text).font(.footnote).foregroundStyle(.secondary)
            if let code {
                Text(code).font(.footnote.monospaced()).textSelection(.enabled)
            }
        }
    }

    // MARK: - Logic

    private var normalizedURL: URL? {
        var raw = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        if !raw.contains("://") { raw = "https://" + raw }
        guard let url = URL(string: raw), url.host != nil else { return nil }
        return url
    }

    private var hostLabel: String { normalizedURL?.host ?? "server" }
    private var canSubmit: Bool { normalizedURL != nil && !token.trimmingCharacters(in: .whitespaces).isEmpty }

    private func submit() async {
        guard let url = normalizedURL else { error = .badURL; return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await session.signIn(serverURL: url, token: token.trimmingCharacters(in: .whitespacesAndNewlines))
            UserDefaults.standard.set(url.absoluteString, forKey: "optio.lastServerURL")
        } catch let e as APIError where e.isUnauthorized {
            error = .rejected
        } catch let e as APIError where e.status == 0 {
            error = .unreachable(url.host ?? serverURL)
        } catch {
            self.error = .other(error.localizedDescription)
        }
    }
}

/// The lucide "bot" outline used for the app icon, as a Shape (24-unit grid).
struct BotGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        let ox = rect.midX - 12 * s
        let oy = rect.midY - 12 * s
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }
        var path = Path()
        // antenna
        path.move(to: p(12, 8)); path.addLine(to: p(12, 4)); path.addLine(to: p(8, 4))
        // head
        path.addRoundedRect(in: CGRect(x: ox + 4 * s, y: oy + 8 * s, width: 16 * s, height: 12 * s), cornerSize: CGSize(width: 2.4 * s, height: 2.4 * s))
        // ears
        path.move(to: p(2, 14)); path.addLine(to: p(4, 14))
        path.move(to: p(20, 14)); path.addLine(to: p(22, 14))
        // eyes
        path.move(to: p(15, 13)); path.addLine(to: p(15, 15))
        path.move(to: p(9, 13)); path.addLine(to: p(9, 15))
        return path
    }
}
