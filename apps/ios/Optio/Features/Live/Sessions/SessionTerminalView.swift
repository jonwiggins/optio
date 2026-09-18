import SwiftUI
import SwiftTerm
import UIKit

/// Owns the `/ws/sessions/:id/terminal` socket and bridges it to a SwiftTerm view.
/// Server → client: binary frames are raw PTY bytes; a JSON `{error}` frame is fatal.
/// Client → server: raw bytes for stdin, `{type:"resize",cols,rows}` for size.
@Observable
@MainActor
final class SessionTerminalController {
    let sessionId: String
    private let api: APIClient
    private var ws: WebSocketClient?
    private var streamTask: Task<Void, Never>?
    weak var terminal: TerminalView?
    var connected = false
    var error: String?
    private var cols = 80
    private var rows = 24

    init(sessionId: String, api: APIClient) {
        self.sessionId = sessionId
        self.api = api
    }

    func start() {
        guard ws == nil else { return }
        let client = WebSocketClient(api: api, path: "/ws/sessions/\(sessionId)/terminal")
        ws = client
        client.connect()
        streamTask = Task { [weak self] in
            for await frame in client.frames {
                guard let self, !Task.isCancelled else { return }
                self.handle(frame)
            }
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        ws?.disconnect()
        ws = nil
        connected = false
    }

    private func handle(_ frame: WebSocketClient.Frame) {
        switch frame {
        case .opened:
            connected = true
            error = nil
            sendResize()
        case .closed(_, let reason):
            connected = false
            if let reason, !reason.isEmpty { error = reason }
            terminal?.feed(text: "\r\n[disconnected]\r\n")
        case .binary(let data):
            terminal?.feed(byteArray: [UInt8](data)[...])
        case .text(let s):
            terminal?.feed(text: s)
        case .json(let obj):
            if let e = obj["error"] as? String {
                error = e
                terminal?.feed(text: "\r\n\u{1b}[31m\(e)\u{1b}[0m\r\n")
            } else if let data = try? JSONSerialization.data(withJSONObject: obj) {
                // Not a control frame we know: display verbatim.
                terminal?.feed(byteArray: [UInt8](data)[...])
            }
        }
    }

    // MARK: Input

    func sendInput(_ bytes: ArraySlice<UInt8>) {
        guard let ws else { return }
        let data = Data(bytes)
        Task { try? await ws.send(binary: data) }
    }

    func sendInput(_ text: String) {
        sendInput(Array(text.utf8)[...])
    }

    func sizeChanged(cols: Int, rows: Int) {
        self.cols = cols
        self.rows = rows
        sendResize()
    }

    private func sendResize() {
        guard connected, let ws else { return }
        let payload: [String: Any] = ["type": "resize", "cols": cols, "rows": rows]
        Task { try? await ws.send(json: payload) }
    }
}

struct SessionTerminalView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Bindable var controller: SessionTerminalController

    var body: some View {
        VStack(spacing: 0) {
            if let error = controller.error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .padding(.vertical, 6)
                    .background(.red.opacity(0.08))
            }
            TerminalHostView(controller: controller)
                .background(TerminalTheme.background(colorScheme))
            TerminalExtraKeysBar { controller.sendInput($0) }
        }
        .onAppear { controller.start() }
    }
}

/// UIViewRepresentable around SwiftTerm's `TerminalView`.
struct TerminalHostView: UIViewRepresentable {
    let controller: SessionTerminalController
    @Environment(\.colorScheme) private var colorScheme

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller) }

    func makeUIView(context: Context) -> TerminalView {
        let view = TerminalView(frame: .zero)
        view.terminalDelegate = context.coordinator
        view.font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        TerminalTheme.apply(to: view, scheme: colorScheme)
        context.coordinator.scheme = colorScheme
        controller.terminal = view
        DispatchQueue.main.async { _ = view.becomeFirstResponder() }
        return view
    }

    func updateUIView(_ uiView: TerminalView, context: Context) {
        if context.coordinator.scheme != colorScheme {
            context.coordinator.scheme = colorScheme
            TerminalTheme.apply(to: uiView, scheme: colorScheme)
        }
    }

    static func dismantleUIView(_ uiView: TerminalView, coordinator: Coordinator) {
        uiView.terminalDelegate = nil
    }

    final class Coordinator: NSObject, TerminalViewDelegate {
        let controller: SessionTerminalController
        var scheme: ColorScheme?
        init(controller: SessionTerminalController) { self.controller = controller }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            let c = controller
            Task { @MainActor in c.sizeChanged(cols: newCols, rows: newRows) }
        }

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            let c = controller
            let bytes = Array(data)
            Task { @MainActor in c.sendInput(bytes[...]) }
        }

        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            if let url = URL(string: link) {
                Task { @MainActor in UIApplication.shared.open(url) }
            }
        }
        func bell(source: TerminalView) {}
        func clipboardCopy(source: TerminalView, content: Data) {
            if let s = String(data: content, encoding: .utf8) {
                Task { @MainActor in UIPasteboard.general.string = s }
            }
        }
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
    }
}

/// Keys a phone keyboard lacks: Esc, Tab, Ctrl combos, arrows, and a few symbols.
struct TerminalExtraKeysBar: View {
    var send: (String) -> Void

    private struct Key: Identifiable {
        let id: String
        let label: String
        let systemImage: String?
        let sequence: String
    }

    private let keys: [Key] = [
        Key(id: "esc", label: "esc", systemImage: nil, sequence: "\u{1b}"),
        Key(id: "tab", label: "tab", systemImage: "arrow.right.to.line", sequence: "\t"),
        Key(id: "up", label: "up", systemImage: "arrow.up", sequence: "\u{1b}[A"),
        Key(id: "down", label: "down", systemImage: "arrow.down", sequence: "\u{1b}[B"),
        Key(id: "left", label: "left", systemImage: "arrow.left", sequence: "\u{1b}[D"),
        Key(id: "right", label: "right", systemImage: "arrow.right", sequence: "\u{1b}[C"),
        Key(id: "pipe", label: "|", systemImage: nil, sequence: "|"),
        Key(id: "tilde", label: "~", systemImage: nil, sequence: "~"),
        Key(id: "dash", label: "-", systemImage: nil, sequence: "-"),
        Key(id: "slash", label: "/", systemImage: nil, sequence: "/"),
    ]

    private let ctrlKeys: [(String, UInt8)] = [
        ("C", 0x03), ("D", 0x04), ("Z", 0x1a), ("L", 0x0c), ("R", 0x12),
        ("A", 0x01), ("E", 0x05), ("U", 0x15), ("K", 0x0b), ("W", 0x17),
    ]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Menu {
                    ForEach(ctrlKeys, id: \.0) { label, code in
                        Button("Ctrl+\(label)") { send(String(UnicodeScalar(code))) }
                    }
                } label: {
                    keyLabel("ctrl", systemImage: nil)
                }
                ForEach(keys) { key in
                    Button { send(key.sequence) } label: { keyLabel(key.label, systemImage: key.systemImage) }
                }
                Button { send("\u{03}") } label: { keyLabel("^C", systemImage: nil) }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
        .background(.bar)
    }

    private func keyLabel(_ text: String, systemImage: String?) -> some View {
        Group {
            if let systemImage { Image(systemName: systemImage) } else { Text(text) }
        }
        .font(.caption.monospaced().weight(.medium))
        .frame(minWidth: 36, minHeight: 30)
        .padding(.horizontal, 6)
        .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 6))
        .foregroundStyle(.primary)
    }
}
