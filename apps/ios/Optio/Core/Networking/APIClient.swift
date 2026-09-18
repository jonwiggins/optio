import Foundation
import Observation

struct APIError: Error, LocalizedError {
    let status: Int
    let message: String
    let body: Data?

    var isUnauthorized: Bool { status == 401 }
    var errorDescription: String? { "\(message) (HTTP \(status))" }
}

/// Thin HTTP client for the Optio API. Mirrors `apps/web/src/lib/api-client.ts`:
/// bearer PAT (`optio_pat_*`) plus optional `x-workspace-id` override.
///
/// Feature modules add typed endpoints as `extension APIClient { ... }` in their
/// own folder, keeping this file protocol-only.
@Observable
final class APIClient: @unchecked Sendable {
    private(set) var baseURL: URL?
    private(set) var token: String?
    var workspaceId: String?
    var onUnauthorized: (@Sendable () -> Void)?

    private let session: URLSession
    let decoder: JSONDecoder
    let encoder: JSONEncoder

    init(session: URLSession = .shared) {
        self.session = session
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { try Self.decodeDate($0) }
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
    }

    func configure(baseURL: URL?, token: String?, workspaceId: String?) {
        self.baseURL = baseURL
        self.token = token
        self.workspaceId = workspaceId
    }

    var isConfigured: Bool { baseURL != nil && token != nil }

    // MARK: - URL building

    func url(_ path: String, query: [String: String?] = [:]) -> URL {
        guard let base = baseURL else { preconditionFailure("APIClient used before configure()") }
        var comps = URLComponents(url: base.appending(path: path), resolvingAgainstBaseURL: false)!
        let items = query.compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }
        if !items.isEmpty { comps.queryItems = items }
        return comps.url!
    }

    /// The `ws(s)://` form of a path, for `WebSocketClient`.
    func wsURL(_ path: String) -> URL {
        var comps = URLComponents(url: url(path), resolvingAgainstBaseURL: false)!
        comps.scheme = comps.scheme == "https" ? "wss" : "ws"
        return comps.url!
    }

    // MARK: - Requests

    struct Empty: Codable {}

    @discardableResult
    func get<T: Decodable>(_ path: String, query: [String: String?] = [:], as type: T.Type = T.self) async throws -> T {
        try await request("GET", path, query: query, body: Optional<Empty>.none)
    }

    @discardableResult
    func post<T: Decodable>(_ path: String, body: (some Encodable)? = Optional<Empty>.none, query: [String: String?] = [:], as type: T.Type = T.self) async throws -> T {
        try await request("POST", path, query: query, body: body)
    }

    @discardableResult
    func patch<T: Decodable>(_ path: String, body: some Encodable, as type: T.Type = T.self) async throws -> T {
        try await request("PATCH", path, query: [:], body: body)
    }

    @discardableResult
    func put<T: Decodable>(_ path: String, body: some Encodable, as type: T.Type = T.self) async throws -> T {
        try await request("PUT", path, query: [:], body: body)
    }

    @discardableResult
    func delete<T: Decodable>(_ path: String, as type: T.Type = T.self) async throws -> T {
        try await request("DELETE", path, query: [:], body: Optional<Empty>.none)
    }

    /// Fire-and-forget variants for endpoints whose body we don't care about.
    func post(_ path: String, body: (some Encodable)? = Optional<Empty>.none) async throws {
        _ = try await raw("POST", path, query: [:], body: body)
    }

    func delete(_ path: String) async throws {
        _ = try await raw("DELETE", path, query: [:], body: Optional<Empty>.none)
    }

    func request<T: Decodable>(_ method: String, _ path: String, query: [String: String?], body: (some Encodable)?) async throws -> T {
        let data = try await raw(method, path, query: query, body: body)
        if T.self == Empty.self { return Empty() as! T }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError(status: 0, message: "Decoding \(T.self) failed: \(error)", body: data)
        }
    }

    func raw(_ method: String, _ path: String, query: [String: String?], body: (some Encodable)?) async throws -> Data {
        var req = URLRequest(url: url(path, query: query))
        req.httpMethod = method
        req.timeoutInterval = 30
        applyHeaders(&req)
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try encoder.encode(body)
        }
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError(status: 0, message: error.localizedDescription, body: nil)
        }
        let http = response as! HTTPURLResponse
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { onUnauthorized?() }
            throw APIError(status: http.statusCode, message: Self.errorMessage(from: data) ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode), body: data)
        }
        return data
    }

    func applyHeaders(_ req: inout URLRequest) {
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let workspaceId { req.setValue(workspaceId, forHTTPHeaderField: "x-workspace-id") }
        req.setValue("application/json", forHTTPHeaderField: "Accept")
    }

    private static func errorMessage(from data: Data) -> String? {
        struct Err: Decodable { var error: String?; var message: String? }
        let parsed = try? JSONDecoder().decode(Err.self, from: data)
        return parsed?.error ?? parsed?.message
    }

    // MARK: - Dates

    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain = ISO8601DateFormatter()

    /// Accepts ISO-8601 with or without fractional seconds, plus epoch millis.
    static func decodeDate(_ decoder: Decoder) throws -> Date {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) {
            if let d = isoFractional.date(from: s) ?? isoPlain.date(from: s) { return d }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unparseable date \(s)")
        }
        let n = try c.decode(Double.self)
        return Date(timeIntervalSince1970: n > 1e11 ? n / 1000 : n)
    }
}

// MARK: - Auth endpoints

extension APIClient {
    func currentUser() async throws -> CurrentUser {
        struct Me: Decodable { var user: CurrentUser }
        return try await get("/api/auth/me", as: Me.self).user
    }

    /// Single-use, short-lived token for WebSocket upgrades (`GET /api/auth/ws-token`).
    func wsToken() async throws -> String {
        struct R: Decodable { var token: String }
        return try await get("/api/auth/ws-token", as: R.self).token
    }
}
