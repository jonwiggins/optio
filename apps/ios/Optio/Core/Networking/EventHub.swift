import Foundation
import Observation

/// App-scoped subscription to `/ws/events`: one socket, fanned out to any number of
/// observers (Live Activity manager, widget reloads, hub refreshes). Frames are the
/// generated `WsEvent` union; unknown types arrive as `.unknown`.
@MainActor
@Observable
final class EventHub {
    private let api: APIClient
    private var socket: WebSocketClient?
    private var pump: Task<Void, Never>?
    private var handlers: [UUID: (WsEvent) -> Void] = [:]
    private(set) var connected = false

    init(api: APIClient) { self.api = api }

    func start() {
        guard socket == nil, api.isConfigured else { return }
        let ws = WebSocketClient(api: api, path: "/ws/events")
        socket = ws
        ws.connect()
        pump = Task { [weak self] in
            for await frame in ws.frames {
                guard let self else { return }
                switch frame {
                case .opened: connected = true
                case .closed: connected = false
                case .json(let obj):
                    guard let data = try? JSONSerialization.data(withJSONObject: obj),
                          let event = try? api.decoder.decode(WsEvent.self, from: data) else { continue }
                    for h in handlers.values { h(event) }
                default: break
                }
            }
        }
    }

    func stop() {
        pump?.cancel(); pump = nil
        socket?.disconnect(); socket = nil
        connected = false
    }

    /// Subscribe; keep the token alive for as long as you want events.
    func subscribe(_ handler: @escaping (WsEvent) -> Void) -> Subscription {
        let id = UUID()
        handlers[id] = handler
        return Subscription { [weak self] in self?.handlers[id] = nil }
    }

    final class Subscription {
        private let cancel: () -> Void
        init(cancel: @escaping () -> Void) { self.cancel = cancel }
        deinit { cancel() }
    }
}
