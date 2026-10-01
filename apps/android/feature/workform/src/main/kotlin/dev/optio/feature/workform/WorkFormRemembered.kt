package dev.optio.feature.workform

import dev.optio.core.model.ModelProvider
import dev.optio.core.model.ModelProviderPodCredential
import dev.optio.core.model.WorkFormDefaults
import dev.optio.core.network.MODEL_PROVIDER_OPTION_KEY

// "Your last settings": the New work form remembers the runtime and, per runtime, the agent
// options last submitted (`/api/me/work-defaults`), and starts a blank form from them. Pure
// functions over the draft; [WorkFormState] fetches, applies and saves.

/** The saved runtime, when it can run where [d] runs (never the bare terminal); else null. */
fun rememberedRuntime(defaults: WorkFormDefaults, d: WorkDraft): String? {
    val runtime = defaults.runtime?.takeIf { it != TERMINAL } ?: return null
    return runtime.takeIf { r -> runtimeOptions(d).any { it.value == r && it.isEnabled } }
}

/**
 * [runtime]'s saved options that still apply: strings and booleans only, and a model provider only
 * while it is usable here (still there, the org's or yours, serving the runtime, and on a pod not
 * machines-only). Dropping a provider drops its model too (a provider model means nothing without
 * it). A model missing from today's catalog is kept: models can be typed freely.
 */
fun rememberedOptions(
    defaults: WorkFormDefaults,
    runtime: String,
    d: WorkDraft,
    providers: List<ModelProvider>,
    catalogModelField: String? = null,
): Map<String, OptionValue> {
    if (runtime == TERMINAL) return emptyMap()
    val saved = defaults.agentOptions?.get(runtime) ?: return emptyMap()
    val out = LinkedHashMap<String, OptionValue>()
    for ((k, v) in saved) OptionValue.fromJson(v)?.let { out[k] = it }
    val providerId = out[MODEL_PROVIDER_OPTION_KEY]?.stringValue?.trim().orEmpty()
    if (MODEL_PROVIDER_OPTION_KEY in out) {
        val here = d.copy(runtime = runtime)
        val usable = providerId.isNotEmpty() && usableProviders(here, providers).any { p ->
            p.id == providerId && (isLocal(here) || p.podCredential != ModelProviderPodCredential.NONE)
        }
        if (!usable) {
            out.remove(MODEL_PROVIDER_OPTION_KEY)
            if (providerId.isNotEmpty()) out.remove(catalogModelField ?: modelFieldForRuntime(runtime))
        }
    }
    return out
}

/** What a successful create remembers: the runtime and the options it was submitted with. Null for a terminal. */
fun rememberedAfterCreate(d: WorkDraft): WorkFormDefaults? {
    if (d.runtime == TERMINAL) return null
    val options = setOptions(d).orEmpty()
    return WorkFormDefaults(runtime = d.runtime, agentOptions = mapOf(d.runtime to options))
}
