import Foundation
import Observation

/// A terminal's stored conversation: the latest page at start, earlier pages
/// on request (`loadEarlier`), then — while `live` — only the entries past
/// the last seq every few seconds. A long Codex or Claude session can hold
/// thousands of tool outputs; fetching them all before showing anything
/// timed out on a phone. `loaded` flips once the first fetch settles, so the
/// screen can decide its default face (transcript vs. screen) without a flash
/// of the wrong one.
///
/// A finished session whose conversation was never streamed is read off its
/// machine on that first fetch (the server answers `backfilling`): the model
/// polls briefly until the entries land, and `readingConversation` holds the
/// default face meanwhile.
@MainActor
@Observable
final class LocalTranscriptModel {
    private(set) var entries: [LocalTranscriptEntry] = []
    private(set) var loaded = false
    private(set) var backfilling = false
    /// Entries precede the first one held (`loadEarlier` fetches them).
    private(set) var hasEarlier = false
    private(set) var loadingEarlier = false
    /// Why the conversation couldn't be fetched, while nothing is showing.
    private(set) var loadError: String?

    private static let livePoll: Duration = .seconds(4)
    private static let backfillPoll: Duration = .seconds(1)
    private static let backfillPolls = 12
    /// The first page: enough for the last few exchanges, small enough for a phone.
    private static let latestPage = 300
    private static let earlierPage = 300
    private static let livePage = 500
    /// Past any seq the server stores, for the latest page.
    private static let pastEnd = Int(Int32.max)

    private let api: APIClient
    private let terminalId: String
    private var lastSeq = 0
    private var inflight = false
    private var live = false
    private var loadTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?

    init(api: APIClient, terminalId: String) {
        self.api = api
        self.terminalId = terminalId
    }

    var hasEntries: Bool { !entries.isEmpty }

    /// The machine is still reading the conversation and nothing has landed yet.
    var readingConversation: Bool { backfilling && entries.isEmpty }

    /// Fetch the latest page, then keep polling while `live`.
    func start(live: Bool) {
        self.live = live
        loadTask?.cancel()
        loadTask = Task { [weak self] in
            guard let self else { return }
            do {
                let page = try await api.getLocalTerminalTranscript(terminalId, before: Self.pastEnd, limit: Self.latestPage)
                if Task.isCancelled { return }
                entries = page.entries
                hasEarlier = page.hasEarlier ?? false
                backfilling = (page.backfilling ?? false) && page.entries.isEmpty
                lastSeq = page.entries.last.map { Int($0.seq) } ?? 0
                loadError = nil
            } catch {
                if Task.isCancelled { return }
                // Not a dead end: the poll below keeps trying, and the face says why it's empty.
                loadError = error.localizedDescription
            }
            loaded = true
            restartPolling()
        }
    }

    /// Fetch the page before the first entry held.
    func loadEarlier() async {
        guard hasEarlier, !loadingEarlier, let first = entries.first else { return }
        loadingEarlier = true
        defer { loadingEarlier = false }
        do {
            let page = try await api.getLocalTerminalTranscript(terminalId, before: Int(first.seq), limit: Self.earlierPage)
            entries.insert(contentsOf: page.entries, at: 0)
            hasEarlier = page.hasEarlier ?? false
        } catch {
            // The button stays; tapping again retries.
        }
    }

    /// The session ended (or came back): stop or start the live poll. A session
    /// that just ended gets one extra fetch — the daemon flushes the final turn
    /// right before `exit`, after the last poll may have run.
    func setLive(_ live: Bool) {
        guard self.live != live else { return }
        self.live = live
        if loaded { restartPolling() }
    }

    /// Try the first fetch again (after `loadError`).
    func retry() {
        loadError = nil
        start(live: live)
    }

    func stop() {
        loadTask?.cancel()
        pollTask?.cancel()
        loadTask = nil
        pollTask = nil
    }

    private func restartPolling() {
        pollTask?.cancel()
        if backfilling {
            pollTask = Task { [weak self] in
                for _ in 0..<Self.backfillPolls {
                    try? await Task.sleep(for: Self.backfillPoll)
                    if Task.isCancelled { return }
                    guard let self, self.backfilling else { return }
                    await self.fetchMore()
                }
                self?.backfilling = false
                self?.restartPolling()
            }
            return
        }
        if !live && loadError == nil {
            pollTask = Task { [weak self] in await self?.fetchMore() }
            return
        }
        // Live, or the first fetch failed: keep asking.
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.livePoll)
                if Task.isCancelled { return }
                await self?.fetchMore()
            }
        }
    }

    /// Entries past the last seq — or, while nothing is held yet (the first
    /// fetch failed, or a backfill is landing), the latest page.
    private func fetchMore() async {
        guard !inflight else { return }
        inflight = true
        defer { inflight = false }
        do {
            let fromLatest = entries.isEmpty
            let page = fromLatest
                ? try await api.getLocalTerminalTranscript(terminalId, before: Self.pastEnd, limit: Self.latestPage)
                : try await api.getLocalTerminalTranscript(terminalId, after: lastSeq, limit: Self.livePage)
            let recovered = loadError != nil
            loadError = nil
            guard !page.entries.isEmpty else {
                // Nothing new and nothing more being read: a backfill is over.
                if backfilling && !(page.backfilling ?? false) {
                    backfilling = false
                    restartPolling()
                } else if recovered {
                    restartPolling()
                }
                return
            }
            if fromLatest { hasEarlier = page.hasEarlier ?? false }
            lastSeq = Int(page.entries[page.entries.count - 1].seq)
            entries.append(contentsOf: page.entries)
            if recovered { restartPolling() }
        } catch {
            // Transient once something is showing — the next tick retries.
            if entries.isEmpty { loadError = error.localizedDescription }
        }
    }
}

/// Projects the transcript onto `AgentLogEntry` rows so `AgentLogView` renders
/// it like every other agent log in the app. Port of `groupTranscript()` in the
/// web's `transcript-view.tsx`: every `tool_use` is joined with the `tool_result`
/// that answers it (by `toolUseId`) so the result folds under its call.
enum LocalTranscriptLog {
    /// Metadata keys `AgentLogRow` understands beyond the shared `toolName`.
    static let roleKey = "role"
    static let sourceKey = "source"
    static let summaryKey = "summary"
    static let resultKey = "result"
    static let resultIsErrorKey = "resultIsError"

    static func entries(_ transcript: [LocalTranscriptEntry], terminalId: String) -> [AgentLogEntry] {
        var results: [String: LocalTranscriptEntry] = [:]
        for e in transcript where e.kind == .toolResult {
            if let id = e.toolUseId, results[id] == nil { results[id] = e }
        }
        var claimed = Set<Double>()
        for e in transcript where e.kind == .toolUse {
            if let id = e.toolUseId, let r = results[id] { claimed.insert(r.seq) }
        }

        var out: [AgentLogEntry] = []
        out.reserveCapacity(transcript.count)
        for e in transcript {
            let at = e.at ?? ""
            switch e.kind {
            case .toolUse:
                let result = e.toolUseId.flatMap { results[$0] }
                var meta: [String: AnyCodable] = [summaryKey: .string(e.text)]
                if let name = e.toolName { meta["toolName"] = .string(name) }
                if let result {
                    meta[resultKey] = .string(result.text)
                    meta[resultIsErrorKey] = .bool(result.isError)
                }
                out.append(AgentLogEntry(taskId: terminalId, timestamp: at, type: .toolUse, content: e.detail ?? "", metadata: meta))
            case .toolResult:
                // Unmatched results — a call whose entry was capped away — stay as their own rows.
                if claimed.contains(e.seq) { continue }
                var meta: [String: AnyCodable] = [:]
                if let name = e.toolName { meta["toolName"] = .string(name) }
                if e.isError { meta[resultIsErrorKey] = .bool(true) }
                out.append(AgentLogEntry(taskId: terminalId, timestamp: at, type: .toolResult, content: e.text, metadata: meta))
            case .thinking:
                out.append(AgentLogEntry(taskId: terminalId, timestamp: at, type: .thinking, content: e.text))
            case .text, .unknown:
                if e.role == .system {
                    // Not the person: a background task, another agent, a compaction…
                    let source = e.source.map(\.rawValue) ?? "other"
                    out.append(AgentLogEntry(taskId: terminalId, timestamp: at, type: .system, content: e.text,
                                             metadata: [sourceKey: .string(source)]))
                    continue
                }
                let role: String? = e.role == .user ? (e.source == .prompt ? "prompt" : "user") : nil
                let meta: [String: AnyCodable]? = role.map { [roleKey: .string($0)] }
                out.append(AgentLogEntry(taskId: terminalId, timestamp: at, type: .text, content: e.text, metadata: meta))
            }
        }
        return out
    }
}
