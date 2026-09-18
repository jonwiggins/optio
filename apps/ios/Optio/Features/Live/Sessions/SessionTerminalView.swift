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
                HStack(spacing: Spacing.s) {
                    Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
                    Text(error).font(.footnote).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Spacing.l)
                .padding(.vertical, 6)
                .background(TerminalTheme.background(colorScheme))
            }
            TerminalHostView(controller: controller)
                .background(TerminalTheme.background(colorScheme))
            TerminalKeyBar(enabled: controller.connected, send: { controller.sendInput($0[...]) })
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
        let view = ScrollableTerminalView(frame: .zero)
        view.terminalDelegate = context.coordinator
        view.font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        // Finger drags scroll and select; they never become mouse events.
        view.allowMouseReporting = false
        view.autocorrectionType = .default
        view.spellCheckingType = .default
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.smartInsertDeleteType = .no
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
        func bell(source: TerminalView) {
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        }
        func clipboardCopy(source: TerminalView, content: Data) {
            if let s = String(data: content, encoding: .utf8) {
                Task { @MainActor in UIPasteboard.general.string = s }
            }
        }
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
    }
}

