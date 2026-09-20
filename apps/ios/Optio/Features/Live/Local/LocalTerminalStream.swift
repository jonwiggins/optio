import Foundation
import Observation
import SwiftTerm
import UIKit

/// Holds the SwiftTerm host for a screen so the stream model can feed bytes
/// before/after the `UIViewRepresentable` attaches, and so the extra-keys bar
/// can inject key sequences and toggle the keyboard.
///
/// Bytes are held until the host has laid out under its sizing mode: SwiftTerm
/// does not reflow, so a replay fed at the wrong grid would stay sheared.
@MainActor
final class TerminalBridge {
    private(set) weak var host: LocalTerminalHostView?
    private var pending = Data()
    /// The host has laid out for the first time: its natural grid is known.
    var onSettled: (() -> Void)?

    var view: TerminalView? { host?.terminal }

    func attach(_ h: LocalTerminalHostView, mode: TerminalSizing.Mode) {
        host = h
        h.mode = mode
        h.onLayoutSettled = { [weak self] in
            self?.onSettled?()
            self?.flush()
        }
        if h.settled { onSettled?(); flush() }
    }

    func setMode(_ mode: TerminalSizing.Mode) {
        host?.mode = mode
    }

    func feed(_ data: Data) {
        if let host, host.settled {
            host.terminal.feed(byteArray: ArraySlice([UInt8](data)))
        } else {
            pending.append(data)
        }
    }

    func feed(text: String) {
        feed(Data(text.utf8))
    }

    private func flush() {
        guard let host, host.settled, !pending.isEmpty else { return }
        let data = pending
        pending.removeAll()
        host.terminal.feed(byteArray: ArraySlice([UInt8](data)))
    }

    func reset() {
        pending.removeAll()
        view?.getTerminal().resetToInitialState()
    }

    var grid: TerminalGrid? {
        guard let t = view?.getTerminal() else { return nil }
        return TerminalGrid(cols: t.cols, rows: t.rows)
    }
    var naturalGrid: TerminalGrid? { host?.naturalGrid() }
    var applicationCursor: Bool { view?.getTerminal().applicationCursor ?? false }

    func focus() { _ = view?.becomeFirstResponder() }
    func blur() { _ = view?.resignFirstResponder() }
    var isFocused: Bool { view?.isFirstResponder ?? false }
}

/// Viewer for `/ws/local/terminals/:id/stream`. Mirrors `local-terminal.tsx`,
/// `stream-policy.ts` and `sizing.ts`:
/// - server → client: binary = raw terminal bytes (scrollback replay then live),
///   JSON = `status` / `size` / `exit` / `error`
/// - client → server: JSON only — `input` and `resize`
///
/// One PTY, one grid. Attaching never resizes it; only an explicit interaction
/// (focusing the terminal, typing, "Use this screen") claims it for this phone.
/// A viewer that hasn't claimed it renders the announced grid shrunk to fit, so
/// glancing at a laptop session from the phone never forces the laptop's TUI
/// down to phone width.
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
    /// Set once the first terminal bytes arrived — the screen holds real output.
    private(set) var outputSeen = false
    /// The stream has said all it will (exit frame or a final close).
    private(set) var settled = false

    private(set) var mode: TerminalSizing.Mode = .unclaimed
    /// Another viewer owns the PTY grid (or it's the recorded grid of an exited
    /// terminal) and we're rendering it scaled to fit. Drives the strip.
    var foreignGrid: TerminalGrid? {
        if case .passive(let g) = mode { return g }
        return nil
    }
    /// The terminal has exited: `foreignGrid` is the grid its final screen was
    /// recorded at, pinned so it reads the way it ran (no "use this screen").
    private(set) var recorded = false
    var ownsGrid: Bool { mode == .owner }

    var onStatus: ((LocalTerminalState, LocalAttentionState) -> Void)?
    var onExit: ((Int?) -> Void)?

    private let api: APIClient
    private var ws: WebSocketClient?
    private var readTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var terminalDead = false
    private var pendingReset = false
    private var liveOnThisConnection = false
    private var retryRequested = false
    private var disposed = false
    /// Grids we've asked for and not yet heard echoed, oldest first.
    private var sent: [TerminalGrid] = []
    /// The PTY grid last announced by the daemon.
    private var announcedGrid: TerminalGrid?
    /// Bytes that arrived before this connection's `size` frame. The daemon
    /// announces the grid right after the scrollback replay; holding the replay
    /// until then lets it land on the right grid (SwiftTerm can't reflow later).
    private var heldBytes: Data?
    private var holdTask: Task<Void, Never>?

    private static let reconnectDelay: Duration = .seconds(2)
    private static let sizeHold: Duration = .milliseconds(1500)

    init(api: APIClient, terminalId: String) {
        self.api = api
        self.terminalId = terminalId
        // A grid announced while the Screen face was hidden was judged without
        // knowing our natural fit; judge it again once the host has laid out.
        bridge.onSettled = { [weak self] in
            guard let self, let grid = announcedGrid else { return }
            gridAnnounced(grid)
        }
    }

    func connect() {
        guard !disposed else { return }
        readTask?.cancel()
        ws?.disconnect()
        let client = WebSocketClient(api: api, path: "/ws/local/terminals/\(terminalId)/stream", autoReconnect: false)
        ws = client
        liveOnThisConnection = false
        beginHold()
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
        holdTask?.cancel()
        readTask?.cancel()
        ws?.disconnect()
        ws = nil
    }

    // MARK: Server → client

    private func handle(_ frame: WebSocketClient.Frame, from client: WebSocketClient) async {
        guard client === ws else { return }
        switch frame {
        case .opened:
            connState = .connected
            // Attaching never resizes the PTY. If we already own it (reconnect
            // after a blip), re-assert our grid; otherwise wait for `size`.
            if mode == .owner, let grid = bridge.grid { sendResize(grid) }
        case .binary(let data):
            if pendingReset {
                pendingReset = false
                bridge.reset()
            }
            if errorMessage != nil, retrying { errorMessage = nil; retrying = false }
            outputSeen = true
            if heldBytes != nil {
                heldBytes?.append(data)
            } else {
                bridge.feed(data)
            }
        case .text(let s):
            // Non-JSON text is unexpected on this stream; render it so nothing is lost.
            bridge.feed(text: s)
        case .json(let obj):
            guard let data = try? JSONSerialization.data(withJSONObject: obj),
                  let msg = try? api.decoder.decode(LocalStreamServerMessage.self, from: data) else { return }
            switch msg {
            case .status(let p):
                if StreamPolicy.isTerminalStateDead(p.state) { terminalDead = true } else { liveOnThisConnection = true }
                state = p.state
                attentionState = p.attentionState
                onStatus?(p.state, p.attentionState)
            case .size(let p):
                let cols = Int(p.cols), rows = Int(p.rows)
                if cols > 0, rows > 0 { gridAnnounced(TerminalGrid(cols: cols, rows: rows)) }
                releaseHold()
            case .exit(let p):
                terminalDead = true
                settled = true
                releaseHold()
                let code = p.exitCode.map { Int($0) }
                exitCode = code
                bridge.feed(text: "\r\n\u{1b}[2m[process exited\(code.map { " (code \($0))" } ?? "")]\u{1b}[0m\r\n")
                onExit?(code)
            case .error(let p):
                errorMessage = p.message
                releaseHold()
                // An error on a live terminal (e.g. "Host is offline") leaves the socket
                // attached to nothing — close and retry until the daemon is back.
                if liveOnThisConnection, !terminalDead {
                    retrying = true
                    retryRequested = true
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
            releaseHold()
            let action = StreamPolicy.closeAction(code: code, terminalDead: terminalDead, retryRequested: retryRequested)
            retryRequested = false
            switch action {
            case .stop(let message):
                connState = .disconnected
                settled = true
                if let message {
                    errorMessage = message
                    retrying = false
                }
            case .reconnect:
                scheduleReconnect()
            }
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

    private func beginHold() {
        heldBytes = Data()
        holdTask?.cancel()
        holdTask = Task { [weak self] in
            try? await Task.sleep(for: Self.sizeHold)
            guard let self, !Task.isCancelled else { return }
            self.releaseHold()
        }
    }

    private func releaseHold() {
        holdTask?.cancel()
        holdTask = nil
        guard let held = heldBytes else { return }
        heldBytes = nil
        if !held.isEmpty { bridge.feed(held) }
    }

    // MARK: Grid ownership

    private func gridAnnounced(_ grid: TerminalGrid) {
        announcedGrid = grid
        // Until SwiftTerm is mounted our natural fit is unknown, so the grid can't
        // be ours: render it as announced (passive) rather than at phone width.
        let natural = bridge.naturalGrid ?? TerminalGrid(cols: 0, rows: 0)
        mode = TerminalSizing.onGridAnnounced(mode, grid, natural: natural, sent: sent, recorded: terminalDead)
        if let rest = TerminalSizing.ackSentGrid(sent, grid) { sent = rest }
        if terminalDead { recorded = true }
        bridge.setMode(mode)
    }

    /// This screen is being used: size the PTY to it. Nothing left to size once
    /// the process is gone — and a tap to select text must not reflow a replayed
    /// screen out of its recorded grid.
    func claim() {
        guard !terminalDead, !disposed else { return }
        mode = .owner
        bridge.setMode(.owner)
        // Always tell the daemon, even if our grid is what we last sent: another
        // viewer may have resized the PTY in between.
        if let grid = bridge.grid { sendResize(grid) }
    }

    /// The SwiftTerm view's grid changed (rotation, keyboard, our own claim).
    /// Passive renders resize the view too; only the owner tells the PTY.
    func viewGridChanged(_ grid: TerminalGrid) {
        guard mode == .owner else { return }
        sendResize(grid)
    }

    // MARK: Client → server

    func sendInput(_ text: String) {
        guard connState == .connected, let ws else { return }
        Task { try? await ws.send(LocalStreamClientMessage.input(.init(data: text))) }
    }

    func sendInput(bytes: [UInt8]) {
        sendInput(String(decoding: bytes, as: UTF8.self))
    }

    /// An explicit key press (the extra-keys bar) means this is the screen in use
    /// — take the grid first so the program lays out for it before it processes
    /// the keystroke. Keyboard typing is covered by the focus claim.
    func typed(bytes: [UInt8]) {
        if mode != .owner { claim() }
        sendInput(bytes: bytes)
    }

    private func sendResize(_ grid: TerminalGrid) {
        guard grid.cols > 0, grid.rows > 0 else { return }
        sent = TerminalSizing.pushSentGrid(sent, grid)
        guard connState == .connected, let ws else { return }
        Task { try? await ws.send(LocalStreamClientMessage.resize(.init(cols: Double(grid.cols), rows: Double(grid.rows)))) }
    }
}
