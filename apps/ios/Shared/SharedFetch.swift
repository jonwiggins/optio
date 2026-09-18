import Foundation

/// Minimal HTTP client for the widget extension (and intents), using
/// `SharedCredentials`. Deliberately tiny: the extension has ~30 MB and no
/// business pulling in the app's full `APIClient`.
public struct SharedFetch: Sendable {
    public struct Failure: Error, Sendable { public let status: Int; public let message: String }

    public let baseURL: URL
    public let token: String
    public let workspaceId: String?

    public init?() {
        guard let url = SharedCredentials.serverURL, let token = SharedCredentials.token else { return nil }
        baseURL = url
        self.token = token
        workspaceId = SharedCredentials.workspaceId
    }

    public init(baseURL: URL, token: String, workspaceId: String? = nil) {
        self.baseURL = baseURL
        self.token = token
        self.workspaceId = workspaceId
    }

    public static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        let frac = ISO8601DateFormatter(); frac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            let s = try c.decode(String.self)
            if let date = frac.date(from: s) ?? plain.date(from: s) { return date }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "bad date \(s)")
        }
        return d
    }()

    public func get<T: Decodable>(_ path: String, query: [String: String] = [:], as: T.Type = T.self, timeout: TimeInterval = 8) async throws -> T {
        let data = try await raw("GET", path, query: query, body: nil, timeout: timeout)
        return try Self.decoder.decode(T.self, from: data)
    }

    @discardableResult
    public func post(_ path: String, json: [String: Any] = [:], timeout: TimeInterval = 8) async throws -> Data {
        let body = try JSONSerialization.data(withJSONObject: json)
        return try await raw("POST", path, query: [:], body: body, timeout: timeout)
    }

    public func raw(_ method: String, _ path: String, query: [String: String], body: Data?, timeout: TimeInterval) async throws -> Data {
        var comps = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        req.timeoutInterval = timeout
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let workspaceId { req.setValue(workspaceId, forHTTPHeaderField: "x-workspace-id") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw Failure(status: status, message: String(data: data.prefix(200), encoding: .utf8) ?? "")
        }
        return data
    }
}
