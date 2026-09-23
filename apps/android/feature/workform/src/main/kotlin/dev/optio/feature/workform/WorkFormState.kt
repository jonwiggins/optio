package dev.optio.feature.workform

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalHostDir
import dev.optio.core.model.LocalHostState
import dev.optio.core.network.ApiClient
import dev.optio.core.network.CurrentUser
import dev.optio.core.ui.state.ErrorText
import java.time.Clock
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Everything the form screen holds (iOS `WorkFormState`, the hooks in `work-form.tsx`): the draft
 * (always normalized), the server lists it reads, and the derived facts the sections render. Every
 * edit goes through [update], which normalizes the draft, drops the preset highlight, adopts a
 * machine / directory and seeds the agent parameters from the repo.
 *
 * With [edit] the same form reopens saved recurring work: prefilled from its row, its kind locked
 * ([kindLock]), saved by PATCHing the row and syncing its trigger.
 */
@Stable
class WorkFormState(
    private val api: ApiClient,
    private val scope: CoroutineScope,
    presetId: String? = null,
    val edit: EditTarget? = null,
    private val clock: Clock = Clock.systemUTC(),
    private val loadCatalog: suspend (ApiClient, String) -> CatalogState = AgentCatalogCache::load,
) {
    /** The answers so far. Change them with the setters (never assign directly). */
    var draft: WorkDraft by mutableStateOf(initialDraft(presetId, edit))
        private set

    /** The preset whose chip is highlighted; null once the user changes anything. */
    var preset: String? by mutableStateOf(if (edit != null) null else (preset(presetId) ?: PRESETS[0]).id)
        private set

    var repos: List<FormRepo> by mutableStateOf(emptyList())
        private set
    var reposLoading: Boolean by mutableStateOf(true)
        private set
    var hosts: List<LocalHost> by mutableStateOf(emptyList())
        private set
    var hostsLoading: Boolean by mutableStateOf(true)
        private set
    var templates: List<PromptTemplateRow> by mutableStateOf(emptyList())
        private set
    var existingTasks: List<DependencyTaskRow> by mutableStateOf(emptyList())
        private set

    /** The unified list's `total`, for "Job N"; null while unknown. */
    var workCount: Int? by mutableStateOf(null)
        private set

    /** The signed-in account, to prefill "about you" GitHub events with its login. */
    var me: CurrentUser? by mutableStateOf(null)
        private set

    var submitting: Boolean by mutableStateOf(false)
        private set

    /** The last submit failure, shown as a toast; the screen clears it. */
    var error: String? by mutableStateOf(null)

    /** "More options" is open. */
    var more: Boolean by mutableStateOf(false)

    /** The "Wait for" sheet is open. */
    var showDeps: Boolean by mutableStateOf(false)

    /** Where the form should scroll next (gaps, the dev script); the screen consumes it. */
    var scrollRequest: FormSection? by mutableStateOf(null)

    /** Per-provider catalogs (`GET /api/agents/:provider/options`). */
    val catalogs = mutableStateMapOf<String, CatalogState>()

    // region Draft mutation

    /** Every edit goes through here: normalize, drop the preset highlight, adopt, seed. */
    fun update(change: (WorkDraft) -> WorkDraft) {
        draft = normalize(change(draft))
        preset = null
        adoptHostIfNeeded()
        seedOptionsIfNeeded()
    }

    fun applyPreset(id: String) {
        val p = preset(id) ?: return
        draft = normalize(p.apply(draft))
        preset = id
        adoptHostIfNeeded()
        seedOptionsIfNeeded()
        loadCatalog()
    }

    fun setWhen(w: WhenType) {
        update { d ->
            val event = w.event
            if (event != null) {
                val next = if (d.event.type == event) d.event else EventTrigger.default(event)
                d.copy(whenType = w, trigger = TriggerConfig.MANUAL, event = withLoginPrefill(next))
            } else {
                var t = d.trigger.copy(type = w.trigger ?: TriggerType.MANUAL)
                if (t.type == TriggerType.SCHEDULE && t.cronExpression == null) t = t.copy(cronExpression = "0 9 * * *")
                if (t.type == TriggerType.WEBHOOK && t.webhookPath == null) t = t.copy(webhookPath = randomWebhookPath())
                if (t.type == TriggerType.TICKET) {
                    t = t.copy(ticketSource = t.ticketSource ?: TicketSource.GITHUB, ticketLabels = t.ticketLabels ?: emptyList())
                }
                d.copy(whenType = w, trigger = t)
            }
        }
    }

    /**
     * A GitHub event with "you" prefilled from the signed-in GitHub account while its login is
     * blank. (The web prefills only a fresh config, so its default draft, already GitHub-typed,
     * never got one.)
     */
    private fun withLoginPrefill(event: EventTrigger): EventTrigger {
        val login = me?.takeIf { it.provider == "github" }?.username
        if (event.type != EventTriggerType.GITHUB || login.isNullOrEmpty() || event.config.string("login").isNotBlank()) return event
        return event.copy(config = event.config.with("login", JsonPrimitive(login)))
    }

    /** A pod defaults to one of your repos; a machine to the directory as it is. An edit keeps the saved answer. */
    fun setWhere(target: Where) {
        update { d ->
            d.copy(
                location = d.location.copy(runTarget = target),
                withRepo = if (edit != null) d.withRepo else target == Where.CLUSTER,
                agentOptions = emptyMap(),
            )
        }
    }

    /** The picker starts from the repo's defaults only while there is a repo; switching starts over. */
    fun setWithRepo(withRepo: Boolean) = update { it.copy(withRepo = withRepo, agentOptions = emptyMap()) }

    fun setRuntime(runtime: String) {
        update { it.copy(runtime = runtime, agentOptions = emptyMap()) }
        loadCatalog()
    }

    fun setThen(then: Then) = update { it.copy(then = then) }

    fun setRepo(repoId: String) {
        val repo = repos.firstOrNull { it.id == repoId } ?: return
        update { d ->
            d.copy(
                repoId = repo.id,
                repoUrl = repo.repoUrl,
                repoBranch = repo.defaultBranch,
                agentOptions = optionsFromRepo(d.runtime, repo.raw, optionKeys(d.runtime)),
            )
        }
    }

    fun setBranch(branch: String) = update { it.copy(repoBranch = branch) }

    fun setHost(hostId: String) = update { it.copy(location = it.location.copy(localHostId = hostId, localDir = "")) }

    fun setDir(path: String) = update { it.copy(location = it.location.copy(localDir = path)) }

    fun setOption(key: String, value: OptionValue) = update { it.copy(agentOptions = it.agentOptions + (key to value)) }

    fun setCron(expr: String) = update { it.copy(trigger = it.trigger.copy(cronExpression = expr)) }

    fun setWebhookPath(path: String) = update { it.copy(trigger = it.trigger.copy(webhookPath = path.trim())) }

    fun setTicketSource(source: TicketSource) = update { it.copy(trigger = it.trigger.copy(ticketSource = source)) }

    /** Adds a ticket label (ignored when blank or already there). */
    fun addTicketLabel(label: String) {
        val t = label.trim()
        val labels = draft.trigger.ticketLabels.orEmpty()
        if (t.isEmpty() || t in labels) return
        update { it.copy(trigger = it.trigger.copy(ticketLabels = labels + t)) }
    }

    fun removeTicketLabel(label: String) =
        update { it.copy(trigger = it.trigger.copy(ticketLabels = it.trigger.ticketLabels.orEmpty() - label)) }

    /** Sets one event config field (`channelId`, `mentionOnly`, `login`, `repos`, …). */
    fun setEventField(key: String, value: JsonElement) =
        update { d -> d.copy(event = EventTrigger(d.whenType.event ?: d.event.type, d.event.config.with(key, value))) }

    /** Checks or unchecks one event kind. */
    fun toggleEventKind(kind: String) {
        val events = eventsOf(draft.event.config)
        val next = if (kind in events) events - kind else events + kind
        setEventField("events", kotlinx.serialization.json.JsonArray(next.map(::JsonPrimitive)))
    }

    fun setPrompt(prompt: String) = update { it.copy(prompt = prompt) }

    /** "Saved prompts": the template replaces the prompt. */
    fun useTemplate(template: PromptTemplateRow) = update { it.copy(prompt = template.template.orEmpty()) }

    fun setName(name: String) = update { it.copy(name = name) }

    fun setRunName(runName: String) = update { it.copy(runName = runName) }

    fun setDescription(description: String) = update { it.copy(description = description) }

    fun setPriority(priority: Int) = update { it.copy(priority = priority.coerceIn(1, 1000)) }

    fun setMaxRetries(maxRetries: Int) = update { it.copy(maxRetries = maxRetries.coerceIn(0, 10)) }

    fun toggleDependency(taskId: String) =
        update { d -> d.copy(dependsOn = if (taskId in d.dependsOn) d.dependsOn - taskId else d.dependsOn + taskId) }

    fun setSlug(slug: String) = update { it.copy(agent = it.agent.copy(slug = slugify(slug))) }

    fun setPodLifecycle(lifecycle: PodLifecycle) = update { it.copy(agent = it.agent.copy(podLifecycle = lifecycle)) }

    fun setSystemPrompt(text: String) = update { it.copy(agent = it.agent.copy(systemPrompt = text)) }

    fun setAgentsMd(text: String) = update { it.copy(agent = it.agent.copy(agentsMd = text)) }

    // endregion

    // region Loading

    /** Loads the repos, machines, prompts, tasks, the work count and the account, in parallel. */
    fun load() {
        scope.launch { loadRepos() }
        scope.launch { loadHosts() }
        scope.launch { templates = attempt { api.listFormTemplates() }.orEmpty() }
        scope.launch { existingTasks = attempt { api.listDependencyTasks() }.orEmpty() }
        scope.launch { workCount = attempt { api.workCount() } }
        scope.launch { loadMe() }
        loadCatalog()
    }

    private suspend fun loadRepos() {
        val list = attempt { api.listFormRepos() }
        reposLoading = false
        if (list != null) applyRepos(list)
    }

    /**
     * Fills the server lists directly, as [load] would (screenshot tests and previews): nothing is
     * fetched, the catalogs given count as loaded.
     */
    @androidx.annotation.VisibleForTesting
    internal fun preload(
        repos: List<FormRepo> = emptyList(),
        hosts: List<LocalHost> = emptyList(),
        templates: List<PromptTemplateRow> = emptyList(),
        existingTasks: List<DependencyTaskRow> = emptyList(),
        workCount: Int? = null,
        catalogs: Map<String, CatalogState> = emptyMap(),
        me: CurrentUser? = null,
    ) {
        this.catalogs.putAll(catalogs)
        this.templates = templates
        this.existingTasks = existingTasks
        this.workCount = workCount
        this.me = me
        reposLoading = false
        applyRepos(repos)
        this.hosts = hosts
        hostsLoading = false
        adoptHostIfNeeded()
    }

    private fun applyRepos(list: List<FormRepo>) {
        repos = list
        // Pre-select the saved repo (by url) or the first one once the list is known.
        if (draft.repoId.isEmpty() && list.isNotEmpty()) {
            val first = list.firstOrNull { it.repoUrl == draft.repoUrl } ?: list.first()
            val d = draft
            // An edit keeps what the row saved; a new pod draft starts from the repo's parameters
            // (a machine run carries only what the user picks).
            val seed = edit == null && fullOptionsApply(d) && d.withRepo
            draft = d.copy(
                repoId = first.id,
                repoUrl = first.repoUrl,
                repoBranch = if (edit != null) d.repoBranch else first.defaultBranch,
                agentOptions = if (seed) optionsFromRepo(d.runtime, first.raw, optionKeys(d.runtime)) else d.agentOptions,
            )
        }
        seedOptionsIfNeeded()
    }

    private suspend fun loadHosts() {
        hosts = attempt { api.listFormHosts() }.orEmpty()
        hostsLoading = false
        adoptHostIfNeeded()
    }

    private suspend fun loadMe() {
        me = attempt { api.currentUser() } ?: return
        // If GitHub was picked before the account loaded, fill the login in now.
        val d = draft
        if (d.whenType == WhenType.GITHUB) draft = d.copy(event = withLoginPrefill(d.event))
    }

    /** Fetches the catalog for the current runtime's provider (once per provider). */
    fun loadCatalog() {
        if (draft.runtime == TERMINAL) return
        val provider = provider
        if (catalogs[provider] != null && catalogs[provider] !is CatalogState.Failed) return
        catalogs[provider] = CatalogState.Loading
        scope.launch {
            val state = loadCatalog(api, provider)
            catalogs[provider] = state
            if (state is CatalogState.Loaded) onCatalogLoaded(provider, state.catalog)
        }
    }

    /**
     * A repo seeded before its catalog arrived carries only the model: once the catalog is known,
     * the rest of the repo's parameters join it (unless the user has changed them since).
     */
    private fun onCatalogLoaded(provider: String, catalog: ProviderCatalog) {
        if (provider != this.provider) return
        val repo = repoRow ?: return seedOptionsIfNeeded()
        val d = draft
        if (fullOptionsApply(d) && d.withRepo && edit == null &&
            d.agentOptions == optionsFromRepo(d.runtime, repo.raw, listOf(modelFieldForRuntime(d.runtime)))
        ) {
            draft = d.copy(agentOptions = optionsFromRepo(d.runtime, repo.raw, catalog.optionKeys))
        } else {
            seedOptionsIfNeeded()
        }
    }

    private suspend fun <T> attempt(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    // endregion

    // region Derived

    /** The kind an edit keeps, or null for new work. */
    val locked: WorkKind?
        get() = edit?.kind?.kind

    val isEditing: Boolean
        get() = edit != null

    val isLocal: Boolean
        get() = isLocal(draft)

    val kind: WorkKind
        get() = deriveKind(draft)

    val isTerminal: Boolean
        get() = draft.runtime == TERMINAL

    val repoRow: FormRepo?
        get() = repos.firstOrNull { it.id == draft.repoId }

    val host: LocalHost?
        get() = hosts.firstOrNull { it.id == draft.location.localHostId }

    val dirs: List<LocalHostDir>
        get() = host?.dirs.orEmpty()

    val selectedDir: LocalHostDir?
        get() = dirs.firstOrNull { it.path == draft.location.localDir }

    /** On a machine the checkout's git remote is the repo. */
    val localRepoUrl: String?
        get() = if (isLocal) repoUrlFromRemote(selectedDir?.repoUrl) else null

    val effectiveRepoUrl: String
        get() = if (isLocal) localRepoUrl.orEmpty() else draft.repoUrl

    val sentenceContext: SentenceContext
        get() = SentenceContext(repoName = repoRow?.fullName, machineName = host?.name)

    val sentence: List<SentencePart>
        get() = describe(draft, sentenceContext)

    val gaps: List<SentenceField>
        get() = missingFields(draft, sentenceContext)

    val wantsRepoUrl: Boolean
        get() = draft.withRepo && draft.then != Then.WAITS_FOR_MESSAGES

    /** Nothing is missing: the button makes the work. */
    val ready: Boolean
        get() = gaps.isEmpty() && (!wantsRepoUrl || effectiveRepoUrl.isNotEmpty())

    val canSubmit: Boolean
        get() = !submitting && ready

    /** Where a tap on the not-ready button goes: the first gap, or the missing repo. */
    val firstGap: SentenceField?
        get() = gaps.firstOrNull()
            ?: if (wantsRepoUrl && effectiveRepoUrl.isEmpty()) (if (isLocal) SentenceField.CHECKOUT else SentenceField.REPO) else null

    /**
     * Named for what it is ("Job 12", "Terminal 12"), numbered after everything the unified list
     * counts; while the count is unknown (or the API predates `total`), a timestamp so two unnamed
     * rows never collide.
     */
    val autoName: String
        get() = "${kind.word} ${workCount?.let { it + 1 } ?: TIMESTAMP.format(clock.instant())}"

    /** The Name field's placeholder: the saved name while editing, else [autoName]. */
    val namePlaceholder: String
        get() = edit?.savedName ?: autoName

    val params: List<String>
        get() = triggerParams(draft.whenType)

    val provider: String
        get() = providerFor(draft.runtime)

    val catalogState: CatalogState?
        get() = catalogs[provider]

    val catalog: ProviderCatalog?
        get() = catalogState.catalog

    val fullOptionsApply: Boolean
        get() = fullOptionsApply(draft)

    val submitLabel: String
        get() = submitLabel(draft, editing = edit != null)

    val namesRuns: Boolean
        get() = namesRuns(draft)

    /** The picked model's label ("opus" resolves through the catalog's aliases), or "". */
    val modelLabel: String
        get() {
            if (isTerminal) return ""
            val field = catalog?.modelField ?: modelFieldForRuntime(draft.runtime)
            val id = resolveModel(draft.agentOptions[field]?.stringValue.orEmpty(), catalog?.aliases)
            if (id.isEmpty()) return ""
            return catalog?.models?.firstOrNull { it.id == id }?.label ?: id
        }

    /** One line per section header: the answer so far, readable when scrolled past. */
    val summaryWhen: String
        get() = draft.whenType.label

    val summaryWhere: String
        get() = if (isLocal) {
            "${host?.name ?: "My machine"}${if (draft.withRepo) " · new branch" else ""}"
        } else {
            "Optio pod · ${if (draft.withRepo) repoRow?.fullName ?: "a repo" else "no repo"}"
        }

    val summaryWho: String
        get() = if (isTerminal) {
            "Terminal"
        } else {
            runtimeLabel(draft.runtime) + modelLabel.takeIf { it.isNotEmpty() }?.let { " · $it" }.orEmpty()
        }

    val summaryThen: String
        get() = thenTitle(draft.then)

    val summaryName: String
        get() = draft.name.trim().ifEmpty { namePlaceholder }

    /** Which of the machine's directories a run can use: a new branch / PR needs a git checkout. */
    fun usableDir(dir: LocalHostDir): Boolean = usableDir(draft.withRepo, dir)

    /** No paired machine at all (once the list is known). */
    val noHosts: Boolean
        get() = !hostsLoading && hosts.isEmpty()

    // The kind's own rules first, then (editing) the lock on the saved kind.

    private fun lock(patch: (WorkDraft) -> WorkDraft): String? = kindLock(draft, locked, patch)

    val runtimeChoices: List<Choice<String>>
        get() = runtimeOptions(draft).map { c -> c.copy(disabled = c.disabled ?: lock { it.copy(runtime = c.value, agentOptions = emptyMap()) }) }

    val thenChoices: List<Choice<Then>>
        get() = thenOptions(draft).map { c -> c.copy(disabled = c.disabled ?: lock { it.copy(then = c.value) }) }

    fun whenDisabled(w: WhenType): String? = lock { d ->
        if (w.isEvent) d.copy(whenType = w, trigger = TriggerConfig.MANUAL) else d.copy(whenType = w, trigger = TriggerConfig(type = w.trigger!!))
    }

    /** Why the pod can't be picked right now, if it can't. */
    val podDisabled: String?
        get() = whereOptions(draft).first { it.value == Where.CLUSTER }.disabled
            ?: lock { it.copy(location = it.location.copy(runTarget = Where.CLUSTER)) }

    /** Why your machine can't be picked right now, if it can't. */
    val machineDisabled: String?
        get() = lock { it.copy(location = it.location.copy(runTarget = Where.LOCAL)) }
            ?: when {
                noHosts -> "No paired machine — run `optio local up` on your computer first."
                hostsLoading && hosts.isEmpty() -> "Looking for paired machines…"
                else -> null
            }

    fun withRepoDisabled(withRepo: Boolean): String? = lock { it.copy(withRepo = withRepo, agentOptions = emptyMap()) }

    // endregion

    // region Host adoption and option seeding

    private fun optionKeys(runtime: String): List<String> =
        catalogs[providerFor(runtime)].catalog?.optionKeys ?: listOf(modelFieldForRuntime(runtime))

    /**
     * Adopts a host / directory once the list is known: the first online host and its first
     * usable directory (`RunLocationPicker`'s effect).
     */
    fun adoptHostIfNeeded() {
        if (!isLocal || hosts.isEmpty()) return
        val d = draft
        val pickedHost = hosts.firstOrNull { it.id == d.location.localHostId }?.id
            ?: (hosts.firstOrNull { it.state == LocalHostState.ONLINE } ?: hosts[0]).id
        val hostDirs = hosts.firstOrNull { it.id == pickedHost }?.dirs.orEmpty()
        val keep = hostDirs.firstOrNull { it.path == d.location.localDir }
        val pickedDir = if (keep != null && usableDir(d.withRepo, keep)) keep.path else hostDirs.firstOrNull { usableDir(d.withRepo, it) }?.path.orEmpty()
        if (pickedHost != d.location.localHostId || pickedDir != d.location.localDir) {
            draft = d.copy(location = d.location.copy(localHostId = pickedHost, localDir = pickedDir))
        }
    }

    /** A pod Task starts from the repo's configured parameters for the picked runtime. */
    fun seedOptionsIfNeeded() {
        val d = draft
        if (!fullOptionsApply(d) || !d.withRepo || d.agentOptions.isNotEmpty()) return
        val repo = repoRow ?: return
        val seeded = optionsFromRepo(d.runtime, repo.raw, optionKeys(d.runtime))
        if (seeded.isNotEmpty()) draft = d.copy(agentOptions = seeded)
    }

    // endregion

    // region Submit

    /**
     * Creates (or, editing, saves) the work. Returns where to go, or null when something is
     * missing or the server refused ([error] says why).
     */
    suspend fun submit(): Created? {
        if (!canSubmit) return null
        if (draft.whenType == WhenType.SCHEDULE && !cronIsValid(draft.trigger.cronExpression)) {
            error = "Invalid cron expression — expected five space-separated fields."
            return null
        }
        submitting = true
        return try {
            val submitter = WorkFormSubmitter(api)
            val target = edit
            if (target != null) submitter.update(target, draft, effectiveRepoUrl) else submitter.create(draft, effectiveRepoUrl, autoName)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = "${if (edit != null) "Couldn't save it" else "Couldn't create it"}: ${ErrorText.humanize(e)}"
            null
        } finally {
            submitting = false
        }
    }

    // endregion

    // region Dev script (screenshots from the command line)

    /**
     * Walks the form into a state for screenshots (iOS `applyDevScript`): [presetId] picks a preset,
     * [tweaks] = `when=github,where=local,repo=0,runtime=,then=waits-for-me,more=1,prompt=hi,name=x,scroll=who`.
     * Returns true when the tweaks ask for a submit (`submit=1`).
     */
    fun applyDevScript(presetId: String?, tweaks: String?): Boolean {
        if (preset(presetId) != null) applyPreset(presetId!!)
        var submit = false
        for (pair in tweaks.orEmpty().split(',').filter { it.isNotEmpty() }) {
            val key = pair.substringBefore('=')
            val value = pair.substringAfter('=', "")
            when (key) {
                "when" -> WhenType.fromRaw(value)?.let(::setWhen)
                "where" -> Where.fromRaw(value)?.let(::setWhere)
                "repo" -> setWithRepo(value == "1")
                "runtime" -> setRuntime(value)
                "then" -> Then.fromRaw(value)?.let(::setThen)
                "more" -> more = value == "1"
                "prompt" -> setPrompt(value)
                "name" -> setName(value)
                "deps" -> showDeps = value == "1"
                "submit" -> submit = value == "1"
                "scroll" -> scrollRequest = FormSection.entries.firstOrNull { it.name.equals(value, ignoreCase = true) } ?: FormSection.WHEN
            }
        }
        return submit
    }

    // endregion

    companion object {
        private val TIMESTAMP: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneOffset.UTC)

        /** The first draft: the saved row's, or [presetId]'s (the first preset by default). */
        fun initialDraft(presetId: String?, edit: EditTarget?): WorkDraft =
            edit?.draft ?: normalize((preset(presetId) ?: PRESETS[0]).apply(WorkDraft.EMPTY))
    }
}

/** The Then card titles (also the Then summary). */
fun thenTitle(then: Then): String = when (then) {
    Then.EXITS -> "Exit when done"
    Then.WAITS_FOR_ME -> "Wait for me"
    Then.WAITS_FOR_MESSAGES -> "Persistent agent"
}
