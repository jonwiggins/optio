import Foundation
import Observation
import SwiftTerm
import UIKit

/// Holds the SwiftTerm view for a screen so the stream model can feed bytes
/// before/after the `UIViewRepresentable` attaches, and so the extra-keys bar
/// can inject key sequences and toggle the keyboard.
@MainActor
final class TerminalBridge {
    weak var view: TerminalView?
    private var pending = Data()

    func attach(_ v: TerminalView) {
        view = v
        if !pending.isEmpty {
            v.feed(byteArray: ArraySlice([UInt8](pending)))
            pending.removeAll()
        }
    }

    func feed(_ data: Data) {
        if let view {
            view.feed(byteArray: ArraySlice([UInt8](data)))
        } else {
            pending.append(data)
        }
    }

    func feed(text: String) {
        feed(Data(text.utf8))
    }

    func reset() {
        pending.removeAll()
        view?.getTerminal().resetToInitialState()
    }

    var cols: Int { view?.getTerminal().cols ?? 80 }
    var rows: Int { view?.getTerminal().rows ?? 24 }
    var applicationCursor: Bool { view?.getTerminal().applicationCursor ?? false }

    func focus() { _ = view?.becomeFirstResponder() }
    func blur() { _ = view?.resignFirstResponder() }
    var isFocused: Bool { view?.isFirstResponder ?? false }
}

/// Viewer for `/ws/local/terminals/:id/stream`. Mirrors `local-terminal.tsx`
/// and `stream-policy.ts`:
/// - server → client: binary = raw terminal bytes (scrollback replay then live),
///   JSON = `status` / `exit` / `error`
/// - client → server: JSON only — `input` and `resize`
@MainActor
@Observable
final class LocalTerminalStream {
    enum ConnState: String { case connecting, connected, reconnecting, disconnected }

    let terminalId: String
    let bridge = TerminalBridge()

    private(set) var connState: ConnState = .connecting
    private(set) var state: LocalTerminalState?
    private(set) var attentionState: LocalAttentionState?
    private(set) var exitCode: Int?
    /// Last `error` frame (e.g. "Host is offline") or permanent close message.
    private(set) var errorMessage: String?
    /// Whether the error is being retried (host offline) vs. terminal.
    private(set) var retrying = false
    private(set) var lastSentSize: (cols: Int, rows: Int)?

    var onStatus: ((LocalTerminalState, LocalAttentionState) -> Void)?
    var onExit: ((Int?) -> Void)?

    private let api: APIClient
    private var ws: WebSocketClient?
    private var readTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var terminalDead = false
    private var pendingReset = false
    private var liveOnThisConnection = false
    /// `.opened` fires before the handshake completes, so the resize sent there may be
    /// dropped; the server's first `status` frame is the earliest guaranteed-open moment.
    private var resizedOnThisConnection = false
    private var disposed = false

    private static let reconnectDelay: Duration = .seconds(2)
    private static let permanentClose: [Int: String] = [
        4401: "Authentication failed — sign in again.",
        4403: "You don't have permission to view this terminal.",
        4429: "Too many connections — close other Optio clients.",
    ]

    init(api: APIClient, terminalId: String) {
        self.api = api
        self.terminalId = terminalId
    }

    func connect() {
        guard !disposed else { return }
        readTask?.cancel()
        ws?.disconnect()
        let client = WebSocketClient(api: api, path: "/ws/local/terminals/\(terminalId)/stream", autoReconnect: false)
        ws = client
        liveOnThisConnection = false
        resizedOnThisConnection = false
        if connState != .reconnecting { connState = .connecting }
        client.connect()
        readTask = Task { [weak self] in
            for await frame in client.frames {
                guard let self, !Task.isCancelled else { return }
                await self.handle(frame, from: client)
            }
        }
    }

    /// User-initiated: drop the current socket and connect again (also clears a dead flag
    /// so a restarted terminal can be re-attached).
    func reconnect() {
        terminalDead = false
        errorMessage = nil
        retrying = false
        pendingReset = true
        connState = .reconnecting
        connect()
    }

    func disconnect() {
        disposed = true
        reconnectTask?.cancel()
        readTask?.cancel()
        ws?.disconnect()
        ws = nil
    }

    private func handle(_ frame: WebSocketClient.Frame, from client: WebSocketClient) async {
        guard client === ws else { return }
        switch frame {
        case .opened:
            connState = .connected
            sendResize(cols: bridge.cols, rows: bridge.rows, force: true)
        case .binary(let data):
            if pendingReset {
                pendingReset = false
                bridge.reset()
            }
            if errorMessage != nil, retrying { errorMessage = nil; retrying = false }
            bridge.feed(data)
        case .text(let s):
            // Non-JSON text is unexpected on this stream; render it so nothing is lost.
            bridge.feed(text: s)
        case .json(let obj):
            guard let data = try? JSONSerialization.data(withJSONObject: obj),
                  let msg = try? api.decoder.decode(LocalStreamServerMessage.self, from: data) else { return }
            switch msg {
            case .status(let p):
                if !resizedOnThisConnection {
                    resizedOnThisConnection = true
                    sendResize(cols: bridge.cols, rows: bridge.rows, force: true)
                }
                if p.state == .exited || p.state == .error { terminalDead = true } else { liveOnThisConnection = true }
                state = p.state
                attentionState = p.attentionState
                onStatus?(p.state, p.attentionState)
            case .exit(let p):
                terminalDead = true
                let code = p.exitCode.map { Int($0) }
                exitCode = code
                bridge.feed(text: "\r\n\u{1b}[2m[process exited\(code.map { " (code \($0))" } ?? "")]\u{1b}[0m\r\n")
                onExit?(code)
            case .error(let p):
                errorMessage = p.message
                // An error on a live terminal (e.g. "Host is offline") leaves the socket
                // attached to nothing — close and retry until the daemon is back.
                if liveOnThisConnection, !terminalDead {
                    retrying = true
                    client.disconnect() // finishes the frame stream — no `.closed` follows
                    scheduleReconnect()
                } else {
                    retrying = false
                }
            case .unknown:
                break
            }
        case .closed(let code, _):
            if disposed { return }
            if let permanent = Self.permanentClose[code] {
                connState = .disconnected
                errorMessage = permanent
                retrying = false
                return
            }
            if terminalDead {
                connState = .disconnected
                return
            }
            // Deliberate closes (ours on dispose, or the server's after a fatal error
            // frame like "Terminal not found") don't loop.
            if code == 1000 || code == 1005 {
                connState = .disconnected
                return
            }
            scheduleReconnect()
        }
    }

    private func scheduleReconnect() {
        guard !disposed else { return }
        connState = .reconnecting
        pendingReset = true
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: Self.reconnectDelay)
            guard let self, !Task.isCancelled, !self.disposed else { return }
            self.connect()
        }
    }

    // MARK: Client → server

    func sendInput(_ text: String) {
        guard connState == .connected, let ws else { return }
        Task { try? await ws.send(LocalStreamClientMessage.input(.init(data: text))) }
    }

    func sendInput(bytes: [UInt8]) {
        sendInput(String(decoding: bytes, as: UTF8.self))
    }

    func sendResize(cols: Int, rows: Int, force: Bool = false) {
        guard cols > 0, rows > 0 else { return }
        if !force, let last = lastSentSize, last.cols == cols, last.rows == rows { return }
        lastSentSize = (cols, rows)
        guard connState == .connected, let ws else { return }
        Task { try? await ws.send(LocalStreamClientMessage.resize(.init(cols: Double(cols), rows: Double(rows)))) }
    }

    // MARK: Extra keys

    enum ExtraKey: String, CaseIterable, Identifiable {
        case esc, tab, ctrlC, ctrlD, up, down, left, right, slash, dash
        var id: String { rawValue }

        var label: String {
            switch self {
            case .esc: return "esc"
            case .tab: return "tab"
            case .ctrlC: return "^C"
            case .ctrlD: return "^D"
            case .up: return "↑"
            case .down: return "↓"
            case .left: return "←"
            case .right: return "→"
            case .slash: return "/"
            case .dash: return "-"
            }
        }
    }

    func send(_ key: ExtraKey) {
        let app = bridge.applicationCursor
        let arrow: (String) -> [UInt8] = { letter in Array("\u{1b}\(app ? "O" : "[")\(letter)".utf8) }
        switch key {
        case .esc: sendInput(bytes: [0x1b])
        case .tab: sendInput(bytes: [0x09])
        case .ctrlC: sendInput(bytes: [0x03])
        case .ctrlD: sendInput(bytes: [0x04])
        case .up: sendInput(bytes: arrow("A"))
        case .down: sendInput(bytes: arrow("B"))
        case .right: sendInput(bytes: arrow("C"))
        case .left: sendInput(bytes: arrow("D"))
        case .slash: sendInput("/")
        case .dash: sendInput("-")
        }
    }
}
