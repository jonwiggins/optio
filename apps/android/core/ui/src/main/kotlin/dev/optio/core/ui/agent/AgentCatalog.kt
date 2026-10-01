package dev.optio.core.ui.agent

import dev.optio.core.model.boolValue
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.state.ErrorText
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// `GET /api/agents/:provider/options`: the provider catalog the web's `AgentOptionsPicker`
// renders (iOS `AgentCatalog.swift`). Fetched lazily per provider and cached for the life of the
// process (per server); when the fetch fails the form falls back to a free-text model field keyed
// by `modelFieldForProvider`.

@Serializable
data class ProviderCatalog(
    val provider: String,
    val label: String,
    val modelField: String,
    val modelIsFreeText: Boolean? = null,
    val modelPlaceholder: String? = null,
    val modelHelpText: String? = null,
    val models: List<Model> = emptyList(),
    val aliases: Map<String, String>? = null,
    val options: List<Option> = emptyList(),
    val liveRefreshSupported: Boolean? = null,
) {
    @Serializable
    data class Model(
        val id: String,
        val label: String,
        val family: String? = null,
        val latest: Boolean? = null,
        val preview: Boolean? = null,
        val source: String? = null,
        /**
         * The reasoning efforts this model accepts, in order (Codex's catalog; Anthropic's
         * `capabilities.effort`). An effort field with [Option.modelEfforts] offers only these while
         * this model is selected; an empty list means the model takes no effort setting at all.
         */
        val efforts: List<String>? = null,
        /** The effort the CLI uses for this model when none is set. */
        val defaultEffort: String? = null,
    ) {
        val displayLabel: String
            get() = buildString {
                append(label)
                if (latest == true) append(" (latest)")
                if (preview == true) append(" (Preview)")
            }
    }

    @Serializable
    data class Choice(
        val value: String,
        val label: String,
        val description: String? = null,
    )

    @Serializable
    data class Option(
        val key: String,
        val label: String,
        /** "select" | "boolean" | "text". */
        val kind: String,
        val choices: List<Choice>? = null,
        val default: JsonElement? = null,
        val placeholder: String? = null,
        val helpText: String? = null,
        /** Where the field applies: "pod" and/or "local" (a run on a machine); null = pods only. */
        val runsOn: List<String>? = null,
        /** On a machine, the agent spec field the value becomes: "effort" or "permissionMode". */
        val localParam: String? = null,
        /** An effort field whose choices depend on the model ([Model.efforts]). */
        val modelEfforts: Boolean? = null,
    ) {
        /** The field reaches a run in an Optio pod (a machine-only one, like Claude's permissions, doesn't). */
        val appliesToPods: Boolean
            get() = runsOn?.contains("pod") ?: true

        /** The daemon hands the field to the agent CLI on a machine (effort, the permission mode). */
        val appliesToLocal: Boolean
            get() = runsOn?.contains("local") ?: false

        val defaultString: String
            get() = default?.stringValue.orEmpty()

        val defaultBool: Boolean
            get() = default?.boolValue ?: false
    }

    /** Keys [optionsFromRepo] reads off a repo row. */
    val optionKeys: List<String>
        get() = listOf(modelField) + options.map { it.key }

    /** The model field plus the options a pod run takes: the repo columns (no machine-only permission modes). */
    val podOptionKeys: List<String>
        get() = listOf(modelField) + options.filter { it.appliesToPods }.map { it.key }

    /** The catalog's entry for a stored model value (an alias resolves first), or null. */
    fun model(raw: String?): Model? {
        val id = resolveModel(raw.orEmpty(), aliases)
        return models.firstOrNull { it.id == id }
    }

    /**
     * The option keys to blank when the model changes to [modelId]: an effort the new model doesn't
     * take goes back to its default rather than riding along into a run it would fail
     * (`agent-options-picker.tsx` `setField`).
     */
    fun effortResets(values: Map<String, OptionValue>, modelId: String): List<String> {
        val efforts = model(modelId)?.efforts ?: return emptyList()
        return options.filter { f ->
            val v = values[f.key]?.stringValue
            f.modelEfforts == true && !v.isNullOrEmpty() && v !in efforts
        }.map { it.key }
    }

    /** Models grouped by family in first-seen order (`groupModelsByFamily`). */
    val families: List<Pair<String, List<Model>>>
        get() = models.groupBy { it.family ?: it.id }.toList()
}

/**
 * The choices [field] offers while [model] is selected (`optionChoicesFor` in packages/shared): a
 * per-model effort field narrows to the model's own efforts, in its order; a model that takes no
 * effort offers none (the field is hidden).
 */
fun optionChoicesFor(field: ProviderCatalog.Option, model: ProviderCatalog.Model?): List<ProviderCatalog.Choice> {
    val choices = field.choices.orEmpty()
    val efforts = model?.efforts
    if (field.modelEfforts != true || efforts == null) return choices
    return efforts.map { e ->
        choices.firstOrNull { it.value == e } ?: ProviderCatalog.Choice(e, e.replaceFirstChar { it.uppercase() })
    }
}

@Serializable
data class ProviderOptionsResponse(
    val provider: String,
    val source: String? = null,
    val cached: Boolean? = null,
    val refreshedAt: Double? = null,
    val catalog: ProviderCatalog,
    val error: String? = null,
)

suspend fun ApiClient.agentProviderOptions(provider: String): ProviderOptionsResponse =
    get("/api/agents/$provider/options")

/** One provider's catalog as the form sees it. */
sealed interface CatalogState {
    data object Loading : CatalogState

    data class Loaded(val catalog: ProviderCatalog) : CatalogState

    data class Failed(val message: String) : CatalogState
}

/** The loaded catalog, or null. */
val CatalogState?.catalog: ProviderCatalog?
    get() = (this as? CatalogState.Loaded)?.catalog

/**
 * What the owning section's footer should add (iOS `AgentOptionsPickerView.footnote`): why the
 * model list is a text field.
 */
fun catalogFootnote(state: CatalogState?): String? = when (state) {
    is CatalogState.Failed -> "Model list unavailable — type a model id. (${state.message})"
    is CatalogState.Loaded -> state.catalog.modelHelpText?.takeIf { state.catalog.modelIsFreeText == true }
    else -> null
}

/**
 * Per-server, per-provider catalog cache shared by every form (iOS `AgentCatalogStore.shared`).
 * Failures are not cached, so the next form tries again.
 */
object AgentCatalogCache {
    private val loaded = ConcurrentHashMap<String, ProviderCatalog>()

    private fun key(api: ApiClient, provider: String) = "${api.baseUrl}|$provider"

    fun cached(api: ApiClient, provider: String): ProviderCatalog? = loaded[key(api, provider)]

    /** The catalog for [provider] on [api]'s server: cached, else fetched. */
    suspend fun load(api: ApiClient, provider: String): CatalogState {
        cached(api, provider)?.let { return CatalogState.Loaded(it) }
        return try {
            val catalog = api.agentProviderOptions(provider).catalog
            loaded[key(api, provider)] = catalog
            CatalogState.Loaded(catalog)
        } catch (e: kotlin.coroutines.cancellation.CancellationException) {
            throw e
        } catch (e: Exception) {
            CatalogState.Failed(ErrorText.humanize(e))
        }
    }

    /** Drops everything (tests). */
    fun clear() = loaded.clear()
}
