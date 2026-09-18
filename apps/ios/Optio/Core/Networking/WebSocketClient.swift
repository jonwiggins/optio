import Foundation

/// WebSocket client mirroring `apps/web/src/lib/ws-client.ts`.
///
/// Auth rides in `Sec-WebSocket-Protocol` as `["optio-ws-v1", "optio-auth-<token>"]`;
/// the server negotiates `optio-ws-v1` so the token is never echoed. Tokens are never
/// placed in the URL. Frames are delivered on an `AsyncStream`; text frames that parse
/// as JSON are delivered as `.json`, other text as `.text`, binary as `.binary`.
final class WebSocketClient: @unchecked Sendable {
    enum Frame: @unchecked Sendable {
        case json([String: Any])
        case text(String)
        case binary(Data)
        case opened
        case closed(code: Int, reason: String?)
    }

    /// Close codes the server uses (see ws/ws-auth.ts, ws/ws-limits.ts).
    enum CloseCode {
        static let unauthorized = 4401
        static let forbidden = 4403
        static let notFound = 4404
        static let helloTimeout = 4408
        static let connectionLimit = 4429
    }

    private let url: URL
    private let tokenProvider: @Sendable () async -> String?
    private let autoReconnect: Bool
    private var task: URLSessionWebSocketTask?
    private var closed = false
    private var continuation: AsyncStream<Frame>.Continuation?
    private let session: URLSession

    let frames: AsyncStream<Frame>

    init(url: URL, tokenProvider: @escaping @Sendable () async -> String?, autoReconnect: Bool = true, session: URLSession = .shared) {
        self.url = url
        self.tokenProvider = tokenProvider
        self.autoReconnect = autoReconnect
        self.session = session
        var cont: AsyncStream<Frame>.Continuation?
        frames = AsyncStream { cont = $0 }
        continuation = cont
    }

    /// Convenience: authenticate with the API client's bearer token (a PAT works
    /// directly in the protocol slot; a short-lived ws-token is used when available).
    convenience init(api: APIClient, path: String, autoReconnect: Bool = true) {
        let url = api.wsURL(path)
        self.init(url: url, tokenProvider: { [weak api] in
            guard let api else { return nil }
            if let t = try? await api.wsToken() { return t }
            return api.token
        }, autoReconnect: autoReconnect)
    }

    func connect() {
        closed = false
        Task { [weak self] in
            guard let self else { return }
            let token = await tokenProvider()
            if closed { return }
            var req = URLRequest(url: url)
            var protocols = ["optio-ws-v1"]
            if let token { protocols.append("optio-auth-\(token)") }
            req.setValue(protocols.joined(separator: ", "), forHTTPHeaderField: "Sec-WebSocket-Protocol")
            let t = session.webSocketTask(with: req)
            task = t
            t.resume()
            continuation?.yield(.opened)
            await receiveLoop(t)
        }
    }

    private func receiveLoop(_ t: URLSessionWebSocketTask) async {
        while !closed, task === t {
            do {
                let msg = try await t.receive()
                switch msg {
                case .string(let s):
                    if let data = s.data(using: .utf8),
                       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        continuation?.yield(.json(obj))
                    } else {
                        continuation?.yield(.text(s))
                    }
                case .data(let d):
                    continuation?.yield(.binary(d))
                @unknown default:
                    break
                }
            } catch {
                let code = t.closeCode.rawValue
                let reason = t.closeReason.flatMap { String(data: $0, encoding: .utf8) }
                continuation?.yield(.closed(code: code, reason: reason))
                if closed || !autoReconnect || code == CloseCode.connectionLimit || code == CloseCode.unauthorized || code == CloseCode.forbidden || code == CloseCode.notFound {
                    return
                }
                try? await Task.sleep(for: .seconds(3))
                if !closed { connect() }
                return
            }
        }
    }

    func send(json: [String: Any]) async throws {
        let data = try JSONSerialization.data(withJSONObject: json)
        try await task?.send(.string(String(decoding: data, as: UTF8.self)))
    }

    func send<T: Encodable>(_ value: T, encoder: JSONEncoder = JSONEncoder()) async throws {
        let data = try encoder.encode(value)
        try await task?.send(.string(String(decoding: data, as: UTF8.self)))
    }

    func send(text: String) async throws { try await task?.send(.string(text)) }
    func send(binary: Data) async throws { try await task?.send(.data(binary)) }

    func disconnect() {
        closed = true
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        continuation?.finish()
    }

    deinit { disconnect() }
}
