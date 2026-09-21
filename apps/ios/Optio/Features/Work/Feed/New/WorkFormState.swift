import Foundation
import Observation

/// A registered repo as the form needs it: the identity columns plus the raw
/// row, so `optionsFromRepo` can read whichever per-provider option columns
/// the picked runtime's catalog names.
struct SessionFormRepo: Identifiable, Hashable, Sendable {
    let id: String
    let fullName: String
    let repoUrl: String
    let defaultBranch: String
    let raw: [String: AnyCodable]

    init?(_ raw: [String: AnyCodable]) {
        guard let id = raw["id"]?.stringValue, let repoUrl = raw["repoUrl"]?.stringValue else { return nil }
        self.id = id
        self.repoUrl = repoUrl
        fullName = raw["fullName"]?.stringValue ?? WorkForm.shortRepo(repoUrl)
        defaultBranch = raw["defaultBranch"]?.stringValue ?? "main"
        self.raw = raw
    }
}

extension APIClient {
    /// `GET /api/repos` as raw rows (see `SessionFormRepo`).
    func listReposRaw() async throws -> [SessionFormRepo] {
        struct R: Decodable { var repos: [[String: AnyCodable]] }
        return try await get("/api/repos", as: R.self).repos.compactMap(SessionFormRepo.init)
    }

    /// How many rows the unified list counts, for the "Job N" placeholder (`total` when the
    /// server sends it, else the page length — like the web).
    func sessionCount() async throws -> Int {
        struct R: Decodable { var tasks: [AnyCodable]; var total: Int? }
        let r = try await get("/api/tasks", query: ["type": "all", "limit": "1"], as: R.self)
        return r.total ?? r.tasks.count
    }
}

/// Everything the form screen holds: the draft (always normalized), the server
/// lists it reads, and the derived facts the sections render. Mirrors the
/// hooks in `session-form.tsx`.
@MainActor
@Observable
final class WorkFormState {
    typealias F = WorkForm

    private(set) var draft: F.Draft
    private(set) var preset: String?

    var repos: [SessionFormRepo] = []
    var reposLoading = true
    var hosts: [LocalHost] = []
    var hostsLoading = true
    var templates: [PromptTemplateRow] = []
    var existingTasks: [TaskRow] = []
    var sessionCount: Int?
    var submitting = false
    var error: String?
    var more = false
    var showDeps = false
    /// Where the form should scroll on the next layout (dev script only).
    var scrollRequest: SessionFormAnchor?
    /// Dev script asked for a submit once the form is filled in.
    var submitRequest = false

    let catalogs = AgentCatalogStore.shared
    private let api: APIClient

    init(api: APIClient) {
        self.api = api
        let first = F.presets[0]
        draft = F.normalize(first.apply(.empty))
        preset = first.id
    }

    // MARK: Draft mutation

    /// Every edit goes through here: normalize, drop the preset highlight.
    func edit(_ change: (inout F.Draft) -> Void) {
        var d = draft
        change(&d)
        draft = F.normalize(d)
        preset = nil
        seedOptionsIfNeeded()
    }

    func applyPreset(_ id: String) {
        guard let p = F.preset(id) else { return }
        draft = F.normalize(p.apply(draft))
        preset = id
        adoptHostIfNeeded()
        seedOptionsIfNeeded()
    }

    func setWhen(_ w: F.WhenType) {
        edit { d in
            if let event = w.event {
                d.when = w
                d.trigger = .manual
                if d.event.type != event { d.event = .default(event) }
            } else {
                d.when = w
                var t = d.trigger
                t.type = w.trigger ?? .manual
                if t.type == .schedule, t.cronExpression == nil { t.cronExpression = "0 9 * * *" }
                if t.type == .webhook, t.webhookPath == nil { t.webhookPath = F.randomWebhookPath() }
                if t.type == .ticket {
                    if t.ticketSource == nil { t.ticketSource = .github }
                    if t.ticketLabels == nil { t.ticketLabels = [] }
                }
                d.trigger = t
            }
        }
        adoptHostIfNeeded()
    }

    /// A pod defaults to one of your repos; a machine to the directory as it is.
    func setWhere(_ target: F.Where) {
        edit { d in
            d.location.runTarget = target
            d.withRepo = target == .cluster
        }
        adoptHostIfNeeded()
    }

    /// The picker starts from the repo's defaults only while there is a repo;
    /// switching it off (or on) starts the parameters over.
    func setWithRepo(_ withRepo: Bool) {
        edit { d in
            d.withRepo = withRepo
            d.agentOptions = [:]
        }
        adoptHostIfNeeded()
    }

    func setRuntime(_ runtime: String) {
        edit { d in
            d.runtime = runtime
            d.agentOptions = [:]
        }
    }

    func setThen(_ then: F.Then) { edit { $0.then = then } }

    func setRepo(_ repoId: String) {
        guard let repo = repos.first(where: { $0.id == repoId }) else { return }
        edit { d in
            d.repoId = repo.id
            d.repoUrl = repo.repoUrl
            d.repoBranch = repo.defaultBranch
            d.agentOptions = F.optionsFromRepo(runtime: d.runtime, repo: repo.raw, keys: optionKeys(for: d.runtime))
        }
    }

    func setHost(_ hostId: String) {
        edit { d in
            d.location.localHostId = hostId
            d.location.localDir = ""
        }
        adoptHostIfNeeded()
    }

    func setOption(_ key: String, _ value: F.OptionValue) {
        edit { $0.agentOptions[key] = value }
    }

    // MARK: Loading

    func load() async {
        async let reposTask: Void = loadRepos()
        async let hostsTask: Void = loadHosts()
        async let rest: Void = loadRest()
        _ = await (reposTask, hostsTask, rest)
    }

    private func loadRepos() async {
        defer { reposLoading = false }
        guard let list = try? await api.listReposRaw() else { return }
        repos = list
        // Pre-select the first repo once the list is known, like the Task form did.
        if draft.repoId.isEmpty, let first = list.first {
            var d = draft
            d.repoId = first.id
            d.repoUrl = first.repoUrl
            d.repoBranch = first.defaultBranch
            d.agentOptions = F.optionsFromRepo(runtime: d.runtime, repo: first.raw, keys: optionKeys(for: d.runtime))
            draft = d
        }
    }

    private func loadHosts() async {
        defer { hostsLoading = false }
        hosts = (try? await api.listLocalHosts()) ?? []
        adoptHostIfNeeded()
    }

    private func loadRest() async {
        async let t = try? api.listPromptTemplates()
        async let x = try? api.listTasks(limit: 100)
        async let c = try? api.sessionCount()
        templates = await t ?? []
        existingTasks = await x ?? []
        sessionCount = await c
    }

    /// Fetch the catalog for the current runtime (once per provider).
    func loadCatalog() {
        guard draft.runtime != F.terminal else { return }
        catalogs.load(F.provider(for: draft.runtime), api: api)
    }

    // MARK: Derived

    var isLocal: Bool { F.isLocal(draft) }
    var kind: F.Kind { F.deriveKind(draft) }
    var isTerminal: Bool { draft.runtime == F.terminal }
    var repoRow: SessionFormRepo? { repos.first { $0.id == draft.repoId } }
    var host: LocalHost? { hosts.first { $0.id == draft.location.localHostId } }
    var selectedDir: LocalHostDir? { host?.dirs.first { $0.path == draft.location.localDir } }
    /// On a machine the checkout's git remote is the repo.
    var localRepoUrl: String? { isLocal ? F.repoUrlFromRemote(selectedDir?.repoUrl) : nil }
    var effectiveRepoUrl: String { isLocal ? (localRepoUrl ?? "") : draft.repoUrl }
    var sentenceContext: F.Context { F.Context(repoName: repoRow?.fullName, machineName: host?.name) }
    var sentence: [F.SentencePart] { F.describe(draft, sentenceContext) }
    var gaps: [F.SentenceField] { F.missingFields(draft, sentenceContext) }
    var wantsRepoUrl: Bool { draft.withRepo && draft.then != .waitsForMessages }
    var canSubmit: Bool { !submitting && gaps.isEmpty && (!wantsRepoUrl || !effectiveRepoUrl.isEmpty) }
    var autoName: String { "\(F.kindWord(kind)) \((sessionCount ?? 0) + 1)" }
    var params: [String] { F.triggerParams(draft.when) }
    var provider: String { F.provider(for: draft.runtime) }
    var catalog: ProviderCatalog? { catalogs.catalog(provider) }
    var fullOptionsApply: Bool { F.fullOptionsApply(draft) }
    var submitLabel: String { F.submitLabel(draft) }

    /// The picked model's label ("opus" resolves through the catalog's aliases), or "".
    var modelLabel: String {
        guard !isTerminal else { return "" }
        let raw = draft.agentOptions[catalog?.modelField ?? F.modelField(forRuntime: draft.runtime)]?.stringValue ?? ""
        let id = F.resolveModel(raw, aliases: catalog?.aliases)
        guard !id.isEmpty else { return "" }
        return catalog?.models.first { $0.id == id }?.label ?? id
    }

    /// One line per card header — the answer so far, readable when scrolled past.
    var summaryWhen: String { draft.when.label }
    var summaryWhere: String {
        if isLocal { return "\(host?.name ?? "My machine")\(draft.withRepo ? " · new branch" : "")" }
        return "Optio pod · \(draft.withRepo ? (repoRow?.fullName ?? "a repo") : "no repo")"
    }
    var summaryWho: String {
        if isTerminal { return "Terminal" }
        let m = modelLabel
        return F.runtimeLabel(draft.runtime) + (m.isEmpty ? "" : " · \(m)")
    }
    var summaryThen: String {
        switch draft.then {
        case .exits: return "Exit when done"
        case .waitsForMe: return "Wait for me"
        case .waitsForMessages: return "Persistent agent"
        }
    }
    var summaryName: String { draft.name.trimmingCharacters(in: .whitespaces).isEmpty ? autoName : draft.name.trimmingCharacters(in: .whitespaces) }

    /// Which of a host's directories a run can use: a new branch / PR needs a git checkout.
    func usableDir(_ dir: LocalHostDir) -> Bool { !draft.withRepo || dir.repoUrl != nil }

    private func optionKeys(for runtime: String) -> [String] {
        catalogs.catalog(F.provider(for: runtime))?.optionKeys ?? [F.modelField(forRuntime: runtime)]
    }

    /// Adopt a host / directory once the list is known: the first online host
    /// and its first usable directory (`RunLocationPicker`'s effect).
    func adoptHostIfNeeded() {
        guard isLocal, !hosts.isEmpty else { return }
        let pickedHost = hosts.first { $0.id == draft.location.localHostId }?.id
            ?? (hosts.first { $0.state == .online } ?? hosts[0]).id
        let dirs = hosts.first { $0.id == pickedHost }?.dirs ?? []
        let keep = dirs.first { $0.path == draft.location.localDir }
        let pickedDir: String
        if let keep, usableDir(keep) { pickedDir = keep.path }
        else { pickedDir = dirs.first { usableDir($0) }?.path ?? "" }
        if pickedHost != draft.location.localHostId || pickedDir != draft.location.localDir {
            var d = draft
            d.location.localHostId = pickedHost
            d.location.localDir = pickedDir
            draft = d
        }
    }

    /// A pod Task starts from the repo's configured parameters for the picked
    /// runtime, so the picker shows what will actually run.
    func seedOptionsIfNeeded() {
        guard fullOptionsApply, draft.withRepo, draft.agentOptions.isEmpty, let repo = repoRow else { return }
        let seeded = F.optionsFromRepo(runtime: draft.runtime, repo: repo.raw, keys: optionKeys(for: draft.runtime))
        if !seeded.isEmpty {
            var d = draft
            d.agentOptions = seeded
            draft = d
        }
    }

    // MARK: Dev script (screenshots from the CLI)

    #if DEBUG
    /// `OPTIO_DEV_NEW_SESSION=<preset id>` picks a preset and
    /// `OPTIO_DEV_NEW_SESSION_TWEAKS=when=github,where=local,repo=0,runtime=,then=waits-for-me,more=1,prompt=hi`
    /// walks the form into a state, so every branch can be screenshotted without tapping.
    func applyDevScript() {
        let env = ProcessInfo.processInfo.environment
        guard let preset = env["OPTIO_DEV_NEW_SESSION"] else { return }
        if F.preset(preset) != nil { applyPreset(preset) }
        for pair in (env["OPTIO_DEV_NEW_SESSION_TWEAKS"] ?? "").split(separator: ",") {
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            let key = kv[0], value = kv.count > 1 ? kv[1] : ""
            switch key {
            case "when": if let w = F.WhenType(rawValue: value) { setWhen(w) }
            case "where": if let w = F.Where(rawValue: value) { setWhere(w) }
            case "repo": setWithRepo(value == "1")
            case "runtime": setRuntime(value)
            case "then": if let t = F.Then(rawValue: value) { setThen(t) }
            case "more": more = value == "1"
            case "prompt": edit { $0.prompt = value }
            case "name": edit { $0.name = value }
            case "deps": showDeps = value == "1"
            case "submit": submitRequest = value == "1"
            case "scroll":
                switch value {
                case "where": scrollRequest = .where
                case "who": scrollRequest = .who
                case "prompt": scrollRequest = .prompt
                case "then": scrollRequest = .then
                case "name": scrollRequest = .name
                default: scrollRequest = .when
                }
            default: break
            }
        }
    }
    #endif

    // MARK: Submit

    func submit() async -> F.Created? {
        guard canSubmit else { return nil }
        if draft.when == .schedule, !F.cronIsValid(draft.trigger.cronExpression) {
            error = "Invalid cron expression — expected five space-separated fields."
            return nil
        }
        submitting = true
        defer { submitting = false }
        do {
            return try await WorkFormSubmitter(api: api).create(draft, repoUrl: effectiveRepoUrl, autoName: autoName)
        } catch {
            self.error = "Couldn't create it: \(ErrorText.humanize(error))"
            return nil
        }
    }
}
