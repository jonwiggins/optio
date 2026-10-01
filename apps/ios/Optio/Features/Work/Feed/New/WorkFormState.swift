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
    /// Model providers you can see (org + yours; admins also see others' by name).
    var providers: [ModelProvider] = []
    /// `GET /api/secrets/pickable`: the org's secret names and yours.
    var pickable: [PickableSecret] = []
    /// Admins may create organization secrets inline.
    var isAdmin = false
    /// One-line note after picking a personal provider moved the work to "Just me".
    var ownerNote: String?
    var submitting = false
    var error: String?
    var more = false
    var showDeps = false
    /// Where the form should scroll on the next layout (dev script only).
    var scrollRequest: WorkFormAnchor?
    /// Dev script asked for a submit once the form is filled in.
    var submitRequest = false
    /// Your last-used runtime + per-runtime options (`GET /api/me/work-defaults`); nil until loaded.
    private(set) var savedDefaults: WorkFormDefaults?
    /// Runtimes whose parameters you've changed here: switching back to one
    /// starts from scratch, not your saved settings, and drops the hint.
    private(set) var touchedRuntimes: Set<String> = []

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
        if draft.agentOptions.isEmpty { startFromSavedOptions() }
        seedOptionsIfNeeded()
        dropUnusableProvider()
    }

    /// A runtime's parameters start from your saved ones unless you've changed them here.
    private func startFromSavedOptions() {
        guard !touchedRuntimes.contains(draft.runtime),
              let saved = F.savedOptions(savedDefaults, runtime: draft.runtime, providers: providers) else { return }
        draft = F.withSavedOptions(draft, saved, providers: providers)
    }

    /// The parameters are still your saved ones ("Your last settings · Reset").
    var lastSettingsShown: Bool {
        guard !isTerminal, !touchedRuntimes.contains(draft.runtime),
              let saved = F.savedOptions(savedDefaults, runtime: draft.runtime, providers: providers) else { return false }
        return F.sameOptions(draft.agentOptions, saved)
    }

    /// Back to the runtime's defaults for this form (the repo's, for a pod Task).
    func resetLastSettings() {
        touchedRuntimes.insert(draft.runtime)
        edit { $0.agentOptions = [:] }
    }

    /// A provider that can't run here any more (new host, pod vs machine) goes back to Default.
    private func dropUnusableProvider() {
        guard let p = pickedProvider else { return }
        let usable = F.usableProviders(providers, runtime: draft.runtime).contains { $0.id == p.id }
        if !usable || F.providerDisabled(p, draft, host: host) != nil {
            draft = F.pickProvider(draft, nil)
        }
    }

    func setProvider(_ p: ModelProvider?) {
        touchedRuntimes.insert(draft.runtime)
        let wasMine = draft.owner == .me
        edit { d in d = F.pickProvider(d, p) }
        ownerNote = (!wasMine && draft.owner == .me && !isLocal) ? "Runs as you now — \(p?.name ?? "this provider") is yours." : nil
    }

    func setOwner(_ owner: ResourceOwner) {
        ownerNote = nil
        edit { d in d = F.setOwner(d, owner, providers: providers, secrets: pickable) }
    }

    func addSecret(_ name: String) {
        edit { d in if !d.podSecrets.contains(name) { d.podSecrets.append(name) } }
    }

    func removeSecret(_ name: String) {
        edit { d in d.podSecrets.removeAll { $0 == name } }
    }

    /// Store a new secret (`scope: "user"` for Just me) and pick it.
    func createSecret(name: String, value: String, owner: ResourceOwner) async -> Bool {
        do {
            _ = try await api.upsertSecret(name: name, value: value, scope: owner == .me ? "user" : "global")
            if let list = try? await api.listPickableSecrets() { pickable = list }
            else { pickable.append(PickableSecret(name: name, owner: owner == .me ? .me : .workspace)) }
            if owner == .me, draft.owner == .workspace, !isLocal { setOwner(.me) }
            addSecret(name)
            return true
        } catch {
            self.error = "Couldn't save the secret: \(ErrorText.humanize(error))"
            return false
        }
    }

    func applyPreset(_ id: String) {
        guard let p = F.preset(id) else { return }
        draft = F.normalize(p.apply(draft))
        preset = id
        adoptHostIfNeeded()
        // A chip that leaves the options blank starts from your saved settings.
        if draft.agentOptions.isEmpty { startFromSavedOptions() }
        seedOptionsIfNeeded()
        dropUnusableProvider()
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

    /// "Work until merged": merge the PR once it's ready (vs. you merge it).
    func setMergeWhenReady(_ merge: Bool) { edit { $0.mergeWhenReady = merge } }

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
        touchedRuntimes.insert(draft.runtime)
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
            // (or keeps your saved settings, when those were applied first).
            if d.agentOptions.isEmpty {
                d.agentOptions = F.optionsFromRepo(runtime: d.runtime, repo: first.raw, keys: optionKeys(for: d.runtime))
            }
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
        async let pr = try? api.listModelProviders()
        async let ps = try? api.listPickableSecrets()
        async let me = try? api.get("/api/auth/me", as: MeRole.self)
        async let wd = try? api.getWorkDefaults()
        providers = await pr ?? []
        applySavedDefaults(await wd ?? WorkFormDefaults())
        pickable = await ps ?? []
        if let me = await me { isAdmin = me.authDisabled == true || (me.user.workspaceRole ?? me.user.role) == "admin" }
        templates = await t ?? []
        existingTasks = await x ?? []
        sessionCount = await c
    }

    /// A blank New work form starts from your last settings — once, and only
    /// while it is still the untouched first example (not anything you've
    /// changed). Another example chip keeps its runtime but takes that
    /// runtime's saved options when it leaves them blank.
    func applySavedDefaults(_ defaults: WorkFormDefaults) {
        savedDefaults = defaults
        guard let preset else { return }
        if preset == F.presets[0].id {
            draft = F.applyDefaults(draft, defaults, providers: providers)
        } else if draft.agentOptions.isEmpty {
            // Another chip picked before the settings loaded: fill its blank options.
            startFromSavedOptions()
        }
        adoptHostIfNeeded()
        dropUnusableProvider()
    }

    /// Fetch the catalog for the current runtime (once per provider).
    func loadCatalog() {
        guard draft.runtime != F.terminal else { return }
        catalogs.load(F.provider(for: draft.runtime), api: api)
    }

    private struct MeRole: Decodable {
        struct User: Decodable { var role: String?; var workspaceRole: String? }
        var user: User
        var authDisabled: Bool?
    }

    // MARK: Derived

    /// Providers that serve the runtime and you may use; empty hides the Provider row.
    var usableProviders: [ModelProvider] { F.usableProviders(providers, runtime: draft.runtime) }
    var pickedProvider: ModelProvider? {
        guard let id = F.modelProviderId(draft) else { return nil }
        return providers.first { $0.id == id }
    }
    /// The picked provider's models for this runtime (nil = the normal catalog).
    var providerModels: [ModelProviderModel]? {
        guard let p = pickedProvider, let agent = F.providerAgent(draft.runtime) else { return nil }
        return F.providerModels(p, agent: agent)
    }
    var takesPodAccess: Bool { F.takesPodAccess(draft) }

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
    /// The repo whose settings decide what happens to the PR: the picked repo on a
    /// pod, or on a machine the registered repo the checkout belongs to, if any.
    var policyRepo: SessionFormRepo? {
        if !isLocal { return repoRow }
        guard !effectiveRepoUrl.isEmpty else { return nil }
        return repos.first { F.repoUrlFromRemote($0.repoUrl) == effectiveRepoUrl }
    }
    /// "What happens to the PR", or nil when the work doesn't open one.
    var prPlan: F.FollowThrough? { F.followThrough(draft, repo: policyRepo.map { F.RepoPrSettings(row: $0.raw) }) }
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
        if let models = providerModels {
            return raw.isEmpty ? "" : (models.first { $0.id == raw }?.label ?? raw)
        }
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
        return F.runtimeLabel(draft.runtime) + (m.isEmpty ? "" : " · \(m)") + (pickedProvider == nil ? "" : " · Bedrock")
    }
    var summaryThen: String {
        switch draft.then {
        case .exits: return "Exit when done"
        case .untilMerged: return "Work until merged"
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
            let created = try await WorkFormSubmitter(api: api).create(draft, repoUrl: effectiveRepoUrl, autoName: autoName, catalog: catalog, providers: providers)
            // Remember what you picked for next time (never blocks or fails the submit).
            if let body = F.workDefaults(from: draft) {
                let api = api
                Task { try? await api.putWorkDefaults(body) }
            }
            return created
        } catch {
            self.error = "Couldn't create it: \(ErrorText.humanize(error))"
            return nil
        }
    }
}
