import SwiftUI

/// First-run screen: server URL (typically a tailnet address) + Personal Access Token.
/// Tokens come from Settings → API keys in the web UI, or `optio login` on the CLI.
struct SignInView: View {
    @Environment(SessionStore.self) private var session
    @State private var serverURL = UserDefaults.standard.string(forKey: "optio.lastServerURL") ?? "http://"
    @State private var token = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://mac.tailnet.ts.net:30400", text: $serverURL)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Server")
                } footer: {
                    Text("The API base URL. On a Tailscale network use the machine's MagicDNS name and the API port (30400 by default).")
                }
                Section {
                    SecureField("optio_pat_…", text: $token)
                        .textContentType(.password)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Personal Access Token")
                } footer: {
                    Text("Create one in the web UI under Settings → API keys, or run `optio login` and copy it from ~/.config/optio/credentials.json.")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        HStack {
                            Spacer()
                            if busy { ProgressView() } else { Text("Connect") }
                            Spacer()
                        }
                    }
                    .disabled(busy || token.isEmpty || URL(string: serverURL)?.host == nil)
                }
            }
            .navigationTitle("Optio")
        }
    }

    private func submit() async {
        guard let url = URL(string: serverURL.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
        busy = true
        defer { busy = false }
        do {
            try await session.signIn(serverURL: url, token: token.trimmingCharacters(in: .whitespacesAndNewlines))
            UserDefaults.standard.set(url.absoluteString, forKey: "optio.lastServerURL")
        } catch {
            self.error = error.localizedDescription
        }
    }
}
