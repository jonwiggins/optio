import SafariServices
import SwiftUI

/// The one way in. The five-attribute form (When → Where → Who → What → Then →
/// Name) lives in the web UI at `/sessions/new`; this sheet opens it in an
/// in-app Safari view against the paired server's web address. A terminal on a
/// paired machine keeps its native shortcut, since that needs no form.
///
/// The app pairs with the *API* address (`:30400`); the web UI usually sits next
/// to it (`:30310`, or the same origin behind an ingress). The guess is editable
/// and remembered per server.
struct NewSessionSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var webURL = ""
    @State private var showForm = false
    @State private var showTerminal = false
    @State private var hosts: [LocalHost] = []

    private var formURL: URL? {
        guard var comps = URLComponents(string: webURL.trimmingCharacters(in: .whitespaces)), comps.scheme != nil, comps.host != nil else { return nil }
        comps.path = comps.path.hasSuffix("/") ? comps.path + "sessions/new" : comps.path + "/sessions/new"
        return comps.url
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        Self.remember(webURL, for: session.activeServer?.id)
                        showForm = true
                    } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Open the New session form")
                                Text("When · Where · Who · What · Then — a PR, a chat on your machine, a schedule, or a persistent agent.")
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: "plus.rectangle.on.rectangle")
                        }
                    }
                    .disabled(formURL == nil)
                } footer: {
                    Text("Opens the web form in-app. Sessions you start there show up in this list within a few seconds.")
                }

                Section {
                    TextField("https://laptop.tailnet.ts.net:30310", text: $webURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                } header: {
                    Text("Web UI address")
                } footer: {
                    Text("Where this server's Optio web UI is served. Remembered for \(session.activeServer?.name ?? "this server").")
                }

                if !hosts.isEmpty {
                    Section {
                        Button {
                            showTerminal = true
                        } label: {
                            Label("Terminal on your machine", systemImage: "laptopcomputer")
                        }
                    } footer: {
                        Text("A plain shell or an agent in a directory on a paired machine, without the form.")
                    }
                }
            }
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
            .task {
                webURL = Self.remembered(for: session.activeServer?.id) ?? Self.guess(from: session.serverURL)
                hosts = ((try? await api.listLocalHosts()) ?? []).filter { $0.state == .online }
            }
            .fullScreenCover(isPresented: $showForm) {
                if let url = formURL {
                    SafariView(url: url).ignoresSafeArea()
                }
            }
            .sheet(isPresented: $showTerminal) {
                NewTerminalSheet(hosts: hosts) { _ in dismiss() }
            }
        }
    }

    // MARK: Web address

    /// `http://host:30400` → `http://host:30310`; anything else is assumed to serve the web UI itself.
    static func guess(from apiURL: URL?) -> String {
        guard let apiURL, var comps = URLComponents(url: apiURL, resolvingAgainstBaseURL: false) else { return "" }
        if comps.port == 30400 { comps.port = 30310 }
        comps.path = ""
        comps.query = nil
        return comps.url?.absoluteString ?? ""
    }

    private static func key(_ serverId: String?) -> String { "optio.webURL.\(serverId ?? "default")" }

    static func remembered(for serverId: String?) -> String? {
        let v = UserDefaults.standard.string(forKey: key(serverId))
        return (v?.isEmpty ?? true) ? nil : v
    }

    static func remember(_ url: String, for serverId: String?) {
        UserDefaults.standard.set(url.trimmingCharacters(in: .whitespaces), forKey: key(serverId))
    }
}

/// In-app Safari for the web form (cookies and the web session stay in Safari's store).
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let config = SFSafariViewController.Configuration()
        config.entersReaderIfAvailable = false
        let vc = SFSafariViewController(url: url, configuration: config)
        vc.preferredControlTintColor = UIColor(AppTheme.accent)
        vc.dismissButtonStyle = .close
        return vc
    }

    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}

/// Toolbar "+" that opens the sheet; one component so every screen offers the same entry.
struct NewSessionButton: View {
    @State private var show = false

    var body: some View {
        Button { show = true } label: { Image(systemName: "plus") }
            .accessibilityLabel("New session")
            .sheet(isPresented: $show) { NewSessionSheet() }
    }
}
