package dev.optio.core.ui.agent

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

// The agent runtimes and their parameters, shared by the New work form's Who section and a repo's
// default-agent settings (the web's `agent-choice-model.ts`), so both offer the same choices from
// the same catalog (`GET /api/agents/:provider/options`). The picker's keys (the catalog's
// `modelField` and option keys) are the repo column names, so mapping a repo row to and from the
// picker is mostly a filter.

// region Runtimes

data class Runtime(val value: String, val label: String)

val RUNTIMES: List<Runtime> = listOf(
    Runtime("claude-code", "Claude Code"),
    Runtime("codex", "OpenAI Codex"),
    Runtime("copilot", "GitHub Copilot"),
    Runtime("gemini", "Google Gemini"),
    Runtime("cursor", "Cursor"),
    Runtime("opencode", "OpenCode"),
    Runtime("openclaw", "OpenClaw"),
)

/** The runtime value of "a terminal with no agent". */
const val TERMINAL = ""

/** "Claude Code" for a runtime, "terminal" for [TERMINAL]. */
fun runtimeLabel(runtime: String): String {
    if (runtime == TERMINAL) return "terminal"
    return RUNTIMES.firstOrNull { it.value == runtime }?.label ?: runtime
}

/** `providerForAgentType` in packages/shared/src/agent-options. */
fun providerFor(runtime: String): String = when (runtime) {
    "codex" -> "openai"
    "gemini" -> "gemini"
    "copilot" -> "copilot"
    "opencode" -> "opencode"
    "openclaw" -> "openclaw"
    "cursor" -> "cursor"
    else -> "anthropic"
}

/**
 * `ProviderCatalog.modelField` per provider: the repo column the model lives in. Known statically
 * so the form can carry a model even when the catalog fetch fails.
 */
fun modelFieldForProvider(provider: String): String = when (provider) {
    "openai", "copilot" -> "copilotModel"
    "gemini" -> "geminiModel"
    "opencode" -> "opencodeModel"
    "openclaw" -> "openclawModel"
    "cursor" -> "cursorModel"
    else -> "claudeModel"
}

fun modelFieldForRuntime(runtime: String): String = modelFieldForProvider(providerFor(runtime))

/**
 * The repo columns a provider's pod options live in (the catalogs' `modelField` + pod option keys
 * in packages/shared/src/agent-options), for when the catalog hasn't loaded.
 */
fun repoKeysForProvider(provider: String): List<String> = when (provider) {
    "anthropic" -> listOf("claudeModel", "claudeContextWindow", "claudeEffort")
    "openai", "copilot" -> listOf("copilotModel", "copilotEffort")
    "gemini" -> listOf("geminiModel", "geminiApprovalMode")
    "opencode" -> listOf("opencodeModel", "opencodeAgent", "opencodeBaseUrl")
    "openclaw" -> listOf("openclawModel", "openclawAgent")
    else -> listOf(modelFieldForProvider(provider))
}

/** A stored alias ("opus") shows as the model it resolves to (`agent-options-picker.tsx`). */
fun resolveModel(raw: String, aliases: Map<String, String>?): String = aliases?.get(raw) ?: raw

// endregion

// region Values

/** A model / provider option value (string or boolean), keyed like the repo columns. */
sealed interface OptionValue {
    data class Str(val value: String) : OptionValue

    data class Bool(val value: Boolean) : OptionValue

    val stringValue: String?
        get() = (this as? Str)?.value

    val boolValue: Boolean?
        get() = (this as? Bool)?.value

    /** A blank select means "the runtime's default". */
    val isBlank: Boolean
        get() = this is Str && value.isEmpty()

    val json: JsonPrimitive
        get() = when (this) {
            is Str -> JsonPrimitive(value)
            is Bool -> JsonPrimitive(value)
        }

    /** The value as a PATCH body takes it. */
    val raw: Any
        get() = when (this) {
            is Str -> value
            is Bool -> value
        }

    companion object {
        /** A JSON string or boolean as an option value; null for anything else. */
        fun fromJson(element: JsonElement?): OptionValue? {
            val primitive = element as? JsonPrimitive ?: return null
            if (primitive.isString) return Str(primitive.content)
            return primitive.booleanOrNull?.let(::Bool)
        }
    }
}

// endregion

// region Repo defaults

/**
 * Runtimes a repo keeps no settings for. Codex shares Copilot's copilotModel / copilotEffort
 * columns, so a repo's values there are Copilot's — Codex runs on its own defaults.
 */
val NO_REPO_SETTINGS: Set<String> = setOf("codex")

/**
 * The repo's configured values for this runtime's options, to seed the picker. [keys] = the
 * catalog's model field plus its option keys (the web reads them off the static catalog).
 */
fun optionsFromRepo(runtime: String, repo: JsonObject?, keys: List<String>): Map<String, OptionValue> {
    if (repo == null || runtime == TERMINAL || runtime in NO_REPO_SETTINGS) return emptyMap()
    val out = LinkedHashMap<String, OptionValue>()
    for (k in keys) OptionValue.fromJson(repo[k])?.let { out[k] = it }
    return out
}

/** What a repo row holds when nobody has set its agent (the DB column defaults). */
const val REPO_FACTORY_AGENT = "claude-code"

val REPO_FACTORY_OPTIONS: Map<String, OptionValue> = mapOf(
    "claudeModel" to OptionValue.Str("opus"),
    "claudeContextWindow" to OptionValue.Str("1m"),
    "claudeEffort" to OptionValue.Str("high"),
    "geminiModel" to OptionValue.Str("gemini-2.5-pro"),
    "geminiApprovalMode" to OptionValue.Str("yolo"),
)

/**
 * Whether the repo has settings of its own for [runtime] — any value that isn't the column
 * default. A repo nobody configured carries the defaults, which shouldn't outrank the settings you
 * used last.
 */
fun repoHasOwnOptions(runtime: String, repo: JsonObject?, keys: List<String>): Boolean =
    optionsFromRepo(runtime, repo, keys).any { (k, v) -> !v.isBlank && REPO_FACTORY_OPTIONS[k] != v }

/** The repo's default agent as the form names it ("claude-code" when unset or unknown). */
fun repoRuntime(repo: JsonObject): String {
    val agent = OptionValue.fromJson(repo["defaultAgentType"])?.stringValue
    return agent?.takeIf { a -> RUNTIMES.any { it.value == a } } ?: REPO_FACTORY_AGENT
}

/** The repo's default agent, when someone picked one (or set its options); null for a repo on the factory defaults. */
fun repoOwnRuntime(repo: JsonObject?, keys: (String) -> List<String>): String? {
    if (repo == null) return null
    val agent = OptionValue.fromJson(repo["defaultAgentType"])?.stringValue ?: return null
    if (RUNTIMES.none { it.value == agent }) return null
    return agent.takeIf { it != REPO_FACTORY_AGENT || repoHasOwnOptions(it, repo, keys(it)) }
}

/** Every agent column a repo row carries ([repoKeysForProvider] over every runtime). */
val REPO_AGENT_KEYS: List<String> = RUNTIMES.flatMap { repoKeysForProvider(providerFor(it.value)) }.distinct()

/** Every agent column on a repo row, as one picker-values map; columns left null read as their default. */
fun repoAgentValues(repo: JsonObject): Map<String, OptionValue> {
    val out = LinkedHashMap<String, OptionValue>()
    for (k in REPO_AGENT_KEYS) OptionValue.fromJson(repo[k])?.let { out[k] = it }
    for ((k, v) in REPO_FACTORY_OPTIONS) if (out[k] == null || out[k]?.isBlank == true) out[k] = v
    return out
}

private val SENT_AS_IS = setOf("claudeModel", "claudeContextWindow", "claudeEffort")

/**
 * The agent part of `PATCH /api/repos/:id` (the web's `repoAgentPatch`): the default agent plus its
 * pod options ([keys] = the catalog's [ProviderCatalog.podOptionKeys]), by the rules the settings
 * page always used: Claude Code's strings go as they are (a blank effort = the model's own), the
 * OpenCode base URL blank clears it (null), and any other blank is left out (left alone). A
 * runtime the repo keeps no settings for ([NO_REPO_SETTINGS]) sends just the agent.
 */
fun repoAgentPatch(runtime: String, values: Map<String, OptionValue>, keys: List<String>): Map<String, Any?> = buildMap {
    put("defaultAgentType", runtime)
    if (runtime in NO_REPO_SETTINGS) return@buildMap
    for (k in keys) {
        val v = values[k]
        when {
            v is OptionValue.Bool -> put(k, v.value)
            k == "opencodeBaseUrl" -> put(k, v?.stringValue?.takeIf { it.isNotEmpty() })
            k in SENT_AS_IS -> v?.let { put(k, it.raw) }
            else -> v?.stringValue?.takeIf { it.isNotEmpty() }?.let { put(k, it) }
        }
    }
}

/** Summary line for a card header: "Claude Code · opus · high". */
fun agentSummary(runtime: String, values: Map<String, OptionValue>): String {
    if (runtime == TERMINAL) return ""
    val keys = if (runtime in NO_REPO_SETTINGS) emptyList() else repoKeysForProvider(providerFor(runtime))
    val model = keys.firstOrNull()?.let { values[it]?.stringValue }
    val effort = keys.firstOrNull { it.endsWith("Effort") }?.let { values[it]?.stringValue }
    return listOfNotNull(runtimeLabel(runtime), model, effort).filter { it.isNotEmpty() }.joinToString(" · ")
}

// endregion

/** The same parameters, blanks aside (the web's `sameOptions`). */
fun sameOptions(a: Map<String, OptionValue>, b: Map<String, OptionValue>): Boolean =
    a.filterValues { !it.isBlank } == b.filterValues { !it.isBlank }
