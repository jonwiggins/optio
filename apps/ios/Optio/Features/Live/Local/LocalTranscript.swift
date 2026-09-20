import Foundation
import Observation

/// A terminal's stored conversation: everything at start (paged), then — while
/// `live` — only the entries past the last seq every few seconds. Port of the
/// web's `use-transcript.ts`. `loaded` flips once the first fetch settles, so
/// the screen can decide its default face (transcript vs. screen) without a
/// flash of the wrong one.
@MainActor
@Observable
final class LocalTranscriptModel {
    private(set) var entries: [LocalTranscriptEntry] = []
    private(set) var loaded = false

    private static let livePoll: Duration = .seconds(4)
    private static let page = 2000

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

    /// Fetch everything stored, then keep polling while `live`.
    func start(live: Bool) {
        self.live = live
        loadTask?.cancel()
        loadTask = Task { [weak self] in
            guard let self else { return }
            var all: [LocalTranscriptEntry] = []
            do {
                var after = 0
                while !Task.isCancelled {
                    let page = try await api.getLocalTerminalTranscript(terminalId, after: after, limit: Self.page)
                    all.append(contentsOf: page.entries)
                    if page.complete || page.entries.isEmpty { break }
                    after = Int(page.entries[page.entries.count - 1].seq)
                }
            } catch {
                // No transcript (older row, non-agent session) — the screen view stands in.
            }
            if Task.isCancelled { return }
            lastSeq = all.last.map { Int($0.seq) } ?? 0
            entries = all
            loaded = true
            restartPolling()
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

    func stop() {
        loadTask?.cancel()
        pollTask?.cancel()
        loadTask = nil
        pollTask = nil
    }

    private func restartPolling() {
        pollTask?.cancel()
        if !live {
            pollTask = Task { [weak self] in await self?.fetchMore() }
            return
        }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.livePoll)
                if Task.isCancelled { return }
                await self?.fetchMore()
            }
        }
    }

    /// Entries past the last seq.
    private func fetchMore() async {
        guard !inflight else { return }
        inflight = true
        defer { inflight = false }
        do {
            let page = try await api.getLocalTerminalTranscript(terminalId, after: lastSeq, limit: Self.page)
            guard !page.entries.isEmpty else { return }
            lastSeq = Int(page.entries[page.entries.count - 1].seq)
            entries.append(contentsOf: page.entries)
        } catch {
            // transient — the next tick retries
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
                let meta: [String: AnyCodable]? = e.role == .user ? [roleKey: .string("user")] : nil
                out.append(AgentLogEntry(taskId: terminalId, timestamp: at, type: .text, content: e.text, metadata: meta))
            }
        }
        return out
    }
}
