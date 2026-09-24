package dev.optio.feature.workform

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
    ) {
        /** The field reaches a run in an Optio pod (a machine-only one, like Claude's permissions, doesn't). */
        val appliesToPods: Boolean
            get() = runsOn?.contains("pod") ?: true

        val defaultString: String
            get() = default?.stringValue.orEmpty()

        val defaultBool: Boolean
            get() = default?.boolValue ?: false
    }

    /** Keys [optionsFromRepo] reads off a repo row. */
    val optionKeys: List<String>
        get() = listOf(modelField) + options.map { it.key }

    /** Models grouped by family in first-seen order (`groupModelsByFamily`). */
    val families: List<Pair<String, List<Model>>>
        get() = models.groupBy { it.family ?: it.id }.toList()
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
