import Foundation
import Observation

/// Owns every conversation independently. Switching the visible session never
/// replaces a draft, cancels a turn, or replays a request after reconnecting.
@Observable @MainActor
final class OptioAssistantWorkspace {
    struct Session: Decodable, Identifiable, Equatable {
        let id: String
        var title: String
        let createdAt: Date
    }
    private struct SessionsResponse: Decodable { let sessions: [Session] }
    private struct SessionResponse: Decodable { let session: Session }
    private(set) var sessions: [Session] = []
    private(set) var models: [String: OptioAssistantModel] = [:]
    var selectedID: String?
    private(set) var isLoading = false
    private(set) var isSaving = false
    private(set) var isLegacy = false
    var error: String?
    private var seen: [String: String] = [:]
    @ObservationIgnored private var isRefreshing = false
    @ObservationIgnored private var hasFetched = false
    @ObservationIgnored private var mutationRevision = 0
    private var isActive = false
    private var refreshTask: Task<Void, Never>?

    var selected: Session? { sessions.first { $0.id == selectedID } }
    var selectedModel: OptioAssistantModel? { selectedID.flatMap { models[$0] } }
    var attentionCount: Int { sessions.filter { models[$0.id]?.needsApproval == true || isUnread($0.id) }.count }

    func title(for session: Session) -> String {
        if session.title == "Ask Optio" { return "Optio Agent" }
        if session.title == "New session", let first = models[session.id]?.rows.first(where: { $0.role == "user" }) {
            return String(first.text.prefix(80))
        }
        return session.title
    }

    func isUnread(_ id: String) -> Bool {
        guard let model = models[id], model.hasLoadedHistory, !model.rows.isEmpty else { return false }
        return seen[id] != model.signature
    }
    func markRead(_ id: String) { if let model = models[id], model.hasLoadedHistory { seen[id] = model.signature } }

    func start(api: APIClient) async {
        isActive = true
        await refresh(api: api)
        guard isActive, refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                guard let self, self.isActive else { return }
                await self.refresh(api: api)
            }
        }
    }

    func stop() {
        isActive = false
        refreshTask?.cancel()
        refreshTask = nil
        models.values.forEach { $0.stop() }
    }

    func refresh(api: APIClient) async {
        guard !isRefreshing, !isSaving else { return }
        isRefreshing = true
        if !hasFetched { isLoading = true }
        let revision = mutationRevision
        defer { isRefreshing = false; isLoading = false }
        do {
            let response: SessionsResponse = try await api.get("/api/optio/sessions")
            // A slow list response must never undo a newer create, rename, or end.
            guard revision == mutationRevision else { return }
            hasFetched = true
            reconcile(response.sessions)
            isLegacy = false
            error = nil
            if isActive { models.values.forEach { $0.start(api: api) } }
        } catch let failure as APIError where failure.status == 404 {
            guard revision == mutationRevision else { return }
            hasFetched = true
            // Older self-hosted servers still have the original default conversation.
            isLegacy = true
            reconcile([Session(id: "legacy", title: "Optio Agent", createdAt: Date())])
            if isActive { models["legacy"]?.start(api: api) }
            error = nil
        } catch {
            if revision == mutationRevision { self.error = "Couldn’t load sessions. \(error.localizedDescription)" }
        }
    }

    /// Preserve each model when another client adds, renames, or ends a session.
    func reconcile(_ incoming: [Session]) {
        let ids = Set(incoming.map(\.id))
        for id in Array(models.keys) where !ids.contains(id) {
            models.removeValue(forKey: id)?.stop()
            seen.removeValue(forKey: id)
        }
        for session in incoming where models[session.id] == nil {
            models[session.id] = OptioAssistantModel(conversationID: session.id == "legacy" ? nil : session.id)
        }
        if sessions != incoming { sessions = incoming }
        if !incoming.contains(where: { $0.id == selectedID }) { selectedID = incoming.first?.id }
    }

    @discardableResult
    func create(api: APIClient) async -> Bool {
        guard !isSaving, !isLoading, !isLegacy else { return false }
        mutationRevision += 1
        isSaving = true
        defer { isSaving = false }
        do {
            let response: SessionResponse = try await api.post("/api/optio/sessions", body: ["title": "New session"])
            reconcile(sessions + [response.session])
            selectedID = response.session.id
            if isActive { selectedModel?.start(api: api) }
            error = nil
            return true
        } catch { self.error = "Couldn’t create a session. \(error.localizedDescription)"; return false }
    }

    @discardableResult
    func rename(_ id: String, title: String, api: APIClient) async -> Bool {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isSaving, !isLoading, !isLegacy, !title.isEmpty, title.count <= 100 else { return false }
        mutationRevision += 1
        isSaving = true
        defer { isSaving = false }
        do {
            let response: SessionResponse = try await api.patch("/api/optio/sessions/\(id)", body: ["title": title])
            if let index = sessions.firstIndex(where: { $0.id == id }) { sessions[index] = response.session }
            error = nil
            return true
        } catch { self.error = "Couldn’t rename the session. \(error.localizedDescription)"; return false }
    }

    @discardableResult
    func end(_ id: String, api: APIClient) async -> Bool {
        guard !isSaving, !isLoading, !isLegacy, models[id]?.canReset == true else { return false }
        mutationRevision += 1
        isSaving = true
        defer { isSaving = false }
        do {
            try await api.delete("/api/optio/sessions/\(id)")
            reconcile(sessions.filter { $0.id != id })
            error = nil
            return true
        } catch { self.error = "Couldn’t end the session. \(error.localizedDescription)"; return false }
    }
}
