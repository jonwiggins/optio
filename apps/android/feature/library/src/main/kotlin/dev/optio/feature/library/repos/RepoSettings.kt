package dev.optio.feature.library.repos

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.mutableStateMapOf
import androidx.lifecycle.viewModelScope
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.agent.ALL_RUNTIME_CHOICES
import dev.optio.core.ui.agent.AgentCatalogCache
import dev.optio.core.ui.agent.AgentOptionsPicker
import dev.optio.core.ui.agent.CatalogState
import dev.optio.core.ui.agent.NO_REPO_SETTINGS
import dev.optio.core.ui.agent.OptionValue
import dev.optio.core.ui.agent.REPO_FACTORY_OPTIONS
import dev.optio.core.ui.agent.RuntimeMenuRow
import dev.optio.core.ui.agent.catalog
import dev.optio.core.ui.agent.catalogFootnote
import dev.optio.core.ui.agent.providerFor
import dev.optio.core.ui.agent.repoAgentPatch
import dev.optio.core.ui.agent.repoAgentValues
import dev.optio.core.ui.agent.repoKeysForProvider
import dev.optio.core.ui.agent.runtimeLabel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.state.LoadState
import dev.optio.feature.library.AgentTypes
import dev.optio.feature.library.CodeKeyboard
import dev.optio.feature.library.FormTextField
import dev.optio.feature.library.GroupedCard
import dev.optio.feature.library.ImagePresets
import dev.optio.feature.library.LibraryForm
import dev.optio.feature.library.LibraryScaffold
import dev.optio.feature.library.LibraryViewModel
import dev.optio.feature.library.NoteRow
import dev.optio.feature.library.PickerRow
import dev.optio.feature.library.RepoRow
import dev.optio.feature.library.ReviewTriggers
import dev.optio.feature.library.ScreenEffects
import dev.optio.feature.library.libraryViewModel
import dev.optio.feature.library.StepperRow
import dev.optio.feature.library.SwitchRow
import dev.optio.feature.library.getRepoWithRaw
import dev.optio.feature.library.updateRepo
import kotlinx.coroutines.Job

/**
 * The editable repo settings (iOS `RepoSettingsView`): the subset of the web's repo page that fits
 * a phone form — general, container image, coding agent, PR lifecycle, review, external review,
 * concurrency and pod policy — with iOS's defaults for unset columns. The coding agent uses the New
 * work form's runtime + parameters picker over the live catalog (`GET /api/agents/:provider/options`),
 * like the web's repo page.
 */
data class RepoSettingsForm(
    val defaultBranch: String = "main",
    val defaultAgentType: String = "claude-code",
    val imagePreset: String = "base",
    val extraPackages: String = "",
    val setupCommands: String = "",
    /**
     * The agent columns as the shared agent picker's values (keys = the catalog's model field and
     * option keys = the repo column names), every runtime's at once so switching agents keeps them.
     */
    val agentValues: Map<String, OptionValue> = REPO_FACTORY_OPTIONS,
    val maxTurnsCoding: Int = 250,
    val maxTurnsReview: Int = 10,
    val cautiousMode: Boolean = false,
    val planningModeEnabled: Boolean = false,
    val reviewEnabled: Boolean = false,
    val reviewTrigger: String = "on_ci_pass",
    /** "" = inherit. */
    val reviewAgentType: String = "",
    /** "" = inherit. */
    val reviewModel: String = "",
    val testCommand: String = "",
    val autoResume: Boolean = false,
    val autoMerge: Boolean = false,
    val externalReviewMode: String = "off",
    val externalReviewWaitForCi: Boolean = true,
    val maxConcurrentTasks: Int = 2,
    val maxPodInstances: Int = 1,
    val maxAgentsPerPod: Int = 2,
    val networkPolicy: String = "unrestricted",
    val secretProxy: Boolean = false,
    val offPeakOnly: Boolean = false,
    val dockerInDocker: Boolean = false,
) {
    /** Pod instances × agents per pod. */
    val capacity: Int
        get() = maxPodInstances * maxAgentsPerPod

    /** iOS: turning cautious mode on turns auto-merge off. */
    fun withCautiousMode(on: Boolean): RepoSettingsForm = copy(cautiousMode = on, autoMerge = if (on) false else autoMerge)

    /**
     * The PATCH body (iOS `RepoUpdateInput`). An empty review agent is an explicit `null`
     * (inherit); an empty review model is omitted (the API takes no null there); an empty extra
     * packages / setup commands is sent as "" so clearing sticks (iOS omits it, and the old value
     * came back; the workers treat "" as none). The agent part is [repoAgentPatch] over
     * [agentKeys], the default agent's pod option keys (the catalog's, else the static columns).
     */
    fun patch(agentKeys: List<String> = repoKeysForProvider(providerFor(defaultAgentType))): Map<String, Any?> = buildMap {
        put("defaultBranch", defaultBranch.trim())
        putAll(repoAgentPatch(defaultAgentType, agentValues, agentKeys))
        put("imagePreset", imagePreset)
        put("extraPackages", extraPackages)
        put("setupCommands", setupCommands)
        put("maxTurnsCoding", maxTurnsCoding)
        put("maxTurnsReview", maxTurnsReview)
        put("maxConcurrentTasks", maxConcurrentTasks)
        put("maxPodInstances", maxPodInstances)
        put("maxAgentsPerPod", maxAgentsPerPod)
        put("cautiousMode", cautiousMode)
        put("planningModeEnabled", planningModeEnabled)
        put("reviewEnabled", reviewEnabled)
        put("reviewTrigger", reviewTrigger)
        put("testCommand", testCommand)
        put("reviewAgentType", reviewAgentType.ifEmpty { null })
        if (reviewModel.isNotEmpty()) put("reviewModel", reviewModel)
        put("autoResume", autoResume)
        put("autoMerge", if (cautiousMode) false else autoMerge)
        put("externalReviewMode", externalReviewMode)
        put("externalReviewWaitForCi", externalReviewWaitForCi)
        put("networkPolicy", networkPolicy)
        put("secretProxy", secretProxy)
        put("offPeakOnly", offPeakOnly)
        put("dockerInDocker", dockerInDocker)
    }

    companion object {
        /** iOS `populate()`; [raw] (the whole row) carries every agent column. */
        fun from(repo: RepoRow, raw: JsonObject? = null): RepoSettingsForm = RepoSettingsForm(
            defaultBranch = repo.defaultBranch ?: "main",
            defaultAgentType = repo.defaultAgentType ?: "claude-code",
            imagePreset = repo.imagePreset ?: "base",
            extraPackages = repo.extraPackages.orEmpty(),
            setupCommands = repo.setupCommands.orEmpty(),
            agentValues = repoAgentValues(raw ?: typedAgentColumns(repo)),
            maxTurnsCoding = repo.maxTurnsCoding ?: 250,
            maxTurnsReview = repo.maxTurnsReview ?: 10,
            cautiousMode = repo.cautiousMode ?: false,
            planningModeEnabled = repo.planningModeEnabled ?: false,
            reviewEnabled = repo.reviewEnabled ?: false,
            reviewTrigger = repo.reviewTrigger ?: "on_ci_pass",
            reviewAgentType = repo.reviewAgentType.orEmpty(),
            reviewModel = repo.reviewModel.orEmpty(),
            testCommand = repo.testCommand.orEmpty(),
            autoResume = repo.autoResume ?: false,
            autoMerge = repo.autoMerge ?: false,
            externalReviewMode = repo.externalReviewMode ?: "off",
            externalReviewWaitForCi = repo.externalReviewWaitForCi ?: true,
            maxConcurrentTasks = repo.maxConcurrentTasks ?: 2,
            maxPodInstances = repo.maxPodInstances ?: 1,
            maxAgentsPerPod = repo.maxAgentsPerPod ?: 2,
            networkPolicy = repo.networkPolicy ?: "unrestricted",
            secretProxy = repo.secretProxy ?: false,
            offPeakOnly = repo.offPeakOnly ?: false,
            dockerInDocker = repo.dockerInDocker ?: false,
        )

        /** The agent columns [RepoRow] types, as a row (when the raw row isn't at hand). */
        private fun typedAgentColumns(repo: RepoRow): JsonObject = buildJsonObject {
            repo.claudeModel?.let { put("claudeModel", it) }
            repo.claudeContextWindow?.let { put("claudeContextWindow", it) }
            repo.claudeEffort?.let { put("claudeEffort", it) }
        }
    }
}

/** Edits a repo's settings with one PATCH, like the web. */
class RepoSettingsViewModel(
    private val api: ApiClient,
    val repoId: String,
    private val loadCatalog: suspend (ApiClient, String) -> CatalogState = AgentCatalogCache::load,
) : LibraryViewModel<RepoRow>() {
    var form by mutableStateOf(RepoSettingsForm())

    /** Per-provider agent catalogs, as the New work form loads them. */
    val catalogs = mutableStateMapOf<String, CatalogState>()

    /** The default agent's catalog. */
    val catalogState: CatalogState?
        get() = catalogs[providerFor(form.defaultAgentType)]

    var saving by mutableStateOf(false)
        private set

    private var populated = false

    override suspend fun fetch(): RepoRow {
        val (repo, raw) = api.getRepoWithRaw(repoId)
        if (!populated) {
            form = RepoSettingsForm.from(repo, raw)
            populated = true
        }
        loadCatalog(form.defaultAgentType)
        return repo
    }

    /** Fetches [runtime]'s catalog once per provider (again after a failure). */
    fun loadCatalog(runtime: String) {
        val provider = providerFor(runtime)
        if (catalogs[provider] != null && catalogs[provider] !is CatalogState.Failed) return
        catalogs[provider] = CatalogState.Loading
        viewModelScope.launch { catalogs[provider] = loadCatalog(api, provider) }
    }

    fun setAgent(runtime: String) {
        update { it.copy(defaultAgentType = runtime) }
        loadCatalog(runtime)
    }

    fun setAgentOption(key: String, value: OptionValue) = update { it.copy(agentValues = it.agentValues + (key to value)) }

    /** The default agent's pod option keys: the loaded catalog's, else the known columns. */
    private val agentKeys: List<String>
        get() = catalogState.catalog?.podOptionKeys ?: repoKeysForProvider(providerFor(form.defaultAgentType))

    fun update(transform: (RepoSettingsForm) -> RepoSettingsForm) {
        form = transform(form)
    }

    fun save(): Job? {
        if (saving || !populated) return null
        saving = true
        return action {
            try {
                api.updateRepo(repoId, form.patch(agentKeys))
                toast("Settings saved.")
                close()
            } finally {
                saving = false
            }
        }
    }
}

internal val ExternalReviewModes = listOf(
    "off" to "Off",
    "on_request" to "On request",
    "on_pr_hold" to "On PR (hold)",
    "on_pr_post" to "On PR (post)",
)
internal val NetworkPolicies = listOf("unrestricted" to "Unrestricted", "restricted" to "Restricted")

@Composable
internal fun RepoSettingsScreen(
    repoId: String,
    vm: RepoSettingsViewModel = libraryViewModel { RepoSettingsViewModel(it, repoId) },
) {
    val state by vm.state.collectAsStateWithLifecycle()
    ScreenEffects(vm.events, onAppear = vm::loadOnce)
    LibraryScaffold(
        title = "Settings",
        actions = {
            TextButton(onClick = vm::save, enabled = !vm.saving && state.value != null, modifier = Modifier.testTag("save")) {
                if (vm.saving) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Save")
            }
        },
    ) { padding ->
        RepoSettingsContent(
            state = state,
            form = vm.form,
            catalog = vm.catalogState,
            onChange = vm::update,
            onAgent = vm::setAgent,
            onAgentOption = vm::setAgentOption,
            onRetry = vm::refresh,
            contentPadding = padding,
        )
    }
}

/** The settings form (stateless): [onChange] applies an edit to [form]. */
@Composable
internal fun RepoSettingsContent(
    state: LoadState<RepoRow>,
    form: RepoSettingsForm,
    catalog: CatalogState?,
    onChange: ((RepoSettingsForm) -> RepoSettingsForm) -> Unit,
    onAgent: (String) -> Unit,
    onAgentOption: (String, OptionValue) -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
) {
    LibraryForm(state, what = "repository", onRetry = onRetry, modifier = modifier, contentPadding = contentPadding, testTag = "repo-settings") { repo ->
        GroupedCard(header = "General") {
            FormTextField(
                form.defaultBranch,
                { v -> onChange { it.copy(defaultBranch = v) } },
                label = "Default branch",
                keyboardOptions = CodeKeyboard,
                modifier = Modifier.testTag("default-branch"),
            )
        }
        GroupedCard(header = "Container image", footer = "Setup commands run inside the pod after cloning.") {
            PickerRow(
                "Preset",
                ImagePresets.all.map { it.id to it.label },
                form.imagePreset,
                { v -> onChange { it.copy(imagePreset = v) } },
                modifier = Modifier.testTag("image-preset"),
            )
            ImagePresets.find(form.imagePreset)?.let { NoteRow(it.description) }
            InsetDivider()
            FormTextField(
                form.extraPackages,
                { v -> onChange { it.copy(extraPackages = v) } },
                label = "Extra apt packages (comma-separated)",
                keyboardOptions = CodeKeyboard,
            )
            InsetDivider()
            FormTextField(
                form.setupCommands,
                { v -> onChange { it.copy(setupCommands = v) } },
                label = "Setup commands (one per line)",
                mono = true,
                singleLine = false,
                minLines = 2,
                keyboardOptions = CodeKeyboard,
            )
        }
        GroupedCard(
            header = "Coding agent",
            footer = listOfNotNull(
                "New work on this repo starts from these — anyone can change them per run.",
                catalogFootnote(catalog).takeIf { form.defaultAgentType !in NO_REPO_SETTINGS },
            ).joinToString(" "),
        ) {
            RuntimeMenuRow(
                label = "Default agent",
                runtime = form.defaultAgentType,
                choices = ALL_RUNTIME_CHOICES,
                onPick = onAgent,
                modifier = Modifier.testTag("default-agent"),
            )
            InsetDivider()
            if (form.defaultAgentType in NO_REPO_SETTINGS) {
                NoteRow("${runtimeLabel(form.defaultAgentType)} uses its built-in defaults. No per-repo configuration is required.")
            } else {
                AgentOptionsPicker(
                    provider = providerFor(form.defaultAgentType),
                    state = catalog,
                    values = form.agentValues,
                    local = false,
                    onChange = onAgentOption,
                )
            }
            InsetDivider()
            StepperRow("Max turns", form.maxTurnsCoding, { v -> onChange { it.copy(maxTurnsCoding = v) } }, range = 1..1000, step = 10)
        }
        GroupedCard(header = "PR lifecycle (Optio-opened PRs)") {
            SwitchRow(
                "Cautious mode",
                form.cautiousMode,
                { v -> onChange { it.withCautiousMode(v) } },
                subtitle = "Draft PRs, no auto-merge; a human marks ready and merges.",
                modifier = Modifier.testTag("cautious-mode"),
            )
            InsetDivider()
            SwitchRow(
                "Planning mode",
                form.planningModeEnabled,
                { v -> onChange { it.copy(planningModeEnabled = v) } },
                subtitle = "Agent plans and waits for approval before coding.",
            )
            InsetDivider()
            SwitchRow("Auto-resume on CI failure, conflicts, or review changes", form.autoResume, { v -> onChange { it.copy(autoResume = v) } })
            InsetDivider()
            SwitchRow(
                "Auto-merge when checks pass and review completes",
                form.autoMerge,
                { v -> onChange { it.copy(autoMerge = v) } },
                enabled = !form.cautiousMode,
                modifier = Modifier.testTag("auto-merge"),
            )
        }
        GroupedCard(header = "Code review") {
            SwitchRow(
                "Automatic code review",
                form.reviewEnabled,
                { v -> onChange { it.copy(reviewEnabled = v) } },
                modifier = Modifier.testTag("review-enabled"),
            )
            if (form.reviewEnabled) {
                InsetDivider()
                PickerRow("Trigger", ReviewTriggers.all, form.reviewTrigger, { v -> onChange { it.copy(reviewTrigger = v) } })
                InsetDivider()
                PickerRow(
                    "Review agent",
                    listOf("" to "Inherit (${AgentTypes.label(repo.effectiveReviewAgentType ?: form.defaultAgentType)})") + AgentTypes.all,
                    form.reviewAgentType,
                    { v -> onChange { it.copy(reviewAgentType = v) } },
                )
                InsetDivider()
                FormTextField(
                    form.reviewModel,
                    { v -> onChange { it.copy(reviewModel = v) } },
                    label = "Review model",
                    placeholder = "blank = inherit" + (repo.effectiveReviewModel?.let { ": $it" } ?: ""),
                    keyboardOptions = CodeKeyboard,
                )
                InsetDivider()
                FormTextField(
                    form.testCommand,
                    { v -> onChange { it.copy(testCommand = v) } },
                    label = "Test command",
                    placeholder = "blank = rely on CI",
                    mono = true,
                    keyboardOptions = CodeKeyboard,
                )
                InsetDivider()
                StepperRow("Review max turns", form.maxTurnsReview, { v -> onChange { it.copy(maxTurnsReview = v) } }, range = 1..100)
            }
        }
        GroupedCard(
            header = "External PR review",
            footer = "Reviews for PRs opened by humans or other bots. Author and label filters are editable on the web.",
        ) {
            PickerRow("Mode", ExternalReviewModes, form.externalReviewMode, { v -> onChange { it.copy(externalReviewMode = v) } })
            if (form.externalReviewMode != "off") {
                InsetDivider()
                SwitchRow("Wait for CI before reviewing", form.externalReviewWaitForCi, { v -> onChange { it.copy(externalReviewWaitForCi = v) } })
            }
        }
        GroupedCard(header = "Concurrency", footer = "Capacity = pod instances × agents per pod (${form.capacity}).") {
            StepperRow("Max concurrent tasks", form.maxConcurrentTasks, { v -> onChange { it.copy(maxConcurrentTasks = v) } }, range = 1..50)
            InsetDivider()
            StepperRow("Max pod instances", form.maxPodInstances, { v -> onChange { it.copy(maxPodInstances = v) } }, range = 1..20)
            InsetDivider()
            StepperRow("Max agents per pod", form.maxAgentsPerPod, { v -> onChange { it.copy(maxAgentsPerPod = v) } }, range = 1..50)
        }
        GroupedCard(header = "Pod policy") {
            PickerRow("Network egress", NetworkPolicies, form.networkPolicy, { v -> onChange { it.copy(networkPolicy = v) } })
            InsetDivider()
            SwitchRow("Secret proxy (Envoy sidecar)", form.secretProxy, { v -> onChange { it.copy(secretProxy = v) } })
            InsetDivider()
            SwitchRow("Off-peak scheduling only", form.offPeakOnly, { v -> onChange { it.copy(offPeakOnly = v) } })
            InsetDivider()
            SwitchRow("Docker-in-Docker", form.dockerInDocker, { v -> onChange { it.copy(dockerInDocker = v) } })
        }
    }
}
