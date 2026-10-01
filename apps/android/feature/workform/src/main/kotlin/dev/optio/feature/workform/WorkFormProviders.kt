package dev.optio.feature.workform

import dev.optio.core.model.LocalHost
import dev.optio.core.model.ModelProvider
import dev.optio.core.model.ModelProviderModel
import dev.optio.core.model.ModelProviderPodCredential
import dev.optio.core.model.PickableSecret
import dev.optio.core.network.MODEL_PROVIDER_OPTION_KEY
import dev.optio.core.network.isOrganization
import dev.optio.core.network.modelsFor
import dev.optio.core.network.serves

// Model providers, owners and pod secrets in the work form (the contract's "Work form" rules):
// pure functions over the draft; [WorkFormState] and the Who / Owner / Secrets rows sit on top.

/** Who a piece of work belongs to: the organization, or the signed-in person. */
enum class WorkOwner(val raw: String, val label: String) {
    WORKSPACE("workspace", "Organization"),
    ME("me", "Just me"),
    ;

    companion object {
        fun fromRaw(raw: String?): WorkOwner? = entries.firstOrNull { it.raw == raw }
    }
}

/** The kinds whose create / update bodies take `owner` and `podSecrets` (a pod session does not). */
private val OWNED_KINDS = setOf(WorkKind.REPO_TASK, WorkKind.REPO_BLUEPRINT, WorkKind.STANDALONE, WorkKind.PERSISTENT_AGENT)

/** The Owner row shows: pod work of a kind that carries an owner. A machine's work is always its owner's. */
fun showsOwner(d: WorkDraft): Boolean = !isLocal(d) && deriveKind(d) in OWNED_KINDS

/** The Secrets row shows: pod work with an agent (not terminals or pod sessions). */
fun showsPodSecrets(d: WorkDraft): Boolean = showsOwner(d) && d.runtime != TERMINAL

/** The owner the server is told: a machine's work is always "me". */
fun effectiveOwner(d: WorkDraft): WorkOwner = if (isLocal(d)) WorkOwner.ME else d.owner

/** The provider id the draft picks, if any. */
fun pickedProviderId(d: WorkDraft): String? = d.agentOptions[MODEL_PROVIDER_OPTION_KEY]?.stringValue?.trim()?.ifEmpty { null }

/** The picked provider among [providers] (null for Default, or one this viewer can't see). */
fun pickedProvider(d: WorkDraft, providers: List<ModelProvider>): ModelProvider? =
    pickedProviderId(d)?.let { id -> providers.firstOrNull { it.id == id } }

/**
 * The providers the Provider control offers for the draft's runtime: the org's, plus the
 * viewer's own (picking one makes the work theirs). Others' personal providers (admins see them
 * by name) are never usable.
 */
fun usableProviders(d: WorkDraft, providers: List<ModelProvider>): List<ModelProvider> {
    if (d.runtime == TERMINAL) return emptyList()
    return providers.filter { p -> p.serves(d.runtime) && (p.isOrganization || p.mine) }
}

/**
 * Why [p] can't be picked here, if it can't: on a machine, a daemon too old for providers or a
 * missing AWS profile; in a pod, a provider set up for machines only.
 */
fun providerDisabled(p: ModelProvider, d: WorkDraft, host: LocalHost?): String? {
    if (isLocal(d)) {
        val name = host?.name ?: "this machine"
        if (host?.modelProviders != true) return "Update Optio Local on $name to use model providers"
        val profile = p.localAwsProfile?.trim().orEmpty()
        if (profile.isNotEmpty() && profile !in host.awsProfiles.orEmpty()) return "AWS profile $profile isn't on $name"
        return null
    }
    if (p.podCredential == ModelProviderPodCredential.NONE) return "Machines only"
    return null
}

/** The model field the runtime's model lives in, for a provider pick. */
private fun modelField(d: WorkDraft, catalogField: String?): String = catalogField ?: modelFieldForRuntime(d.runtime)

/**
 * Picks [p] (null = Default): sets `agentOptions.modelProvider` and the model to the provider's
 * first model (or clears it when it lists none); Default removes the key and the provider's model.
 * A personal provider on pod work makes the work "Just me".
 */
fun withProvider(d: WorkDraft, p: ModelProvider?, catalogModelField: String? = null): WorkDraft {
    val field = modelField(d, catalogModelField)
    val options = LinkedHashMap(d.agentOptions)
    if (p == null) {
        if (options.remove(MODEL_PROVIDER_OPTION_KEY) != null) options.remove(field)
        return d.copy(agentOptions = options)
    }
    options[MODEL_PROVIDER_OPTION_KEY] = OptionValue.Str(p.id)
    options[field] = OptionValue.Str(p.modelsFor(d.runtime).firstOrNull()?.id.orEmpty())
    val owner = if (!p.isOrganization && !isLocal(d)) WorkOwner.ME else d.owner
    return d.copy(agentOptions = options, owner = owner)
}

/** The models the picker offers while a provider is picked; null when none is. */
fun providerModels(d: WorkDraft, providers: List<ModelProvider>): List<ModelProviderModel>? =
    pickedProvider(d, providers)?.modelsFor(d.runtime) ?: pickedProviderId(d)?.let { emptyList() }

/** The secrets the "+ Add secret" menu offers: org work only org secrets; personal work both, one row per name. */
fun addableSecrets(d: WorkDraft, pickable: List<PickableSecret>): List<PickableSecret> {
    val picked = d.podSecrets.orEmpty().toSet()
    val allowed = if (d.owner == WorkOwner.ME) pickable else pickable.filter { it.owner == PickableSecret.Owner.WORKSPACE }
    // A name in both: personal work runs with its owner's, so show it once, as "Just me".
    return allowed.filter { it.name !in picked }
        .sortedBy { if (it.owner == PickableSecret.Owner.ME) 0 else 1 }
        .distinctBy { it.name }
        .sortedBy { it.name.lowercase() }
}

/** A picked secret's owner tag: "Just me" when personal work has its own by that name, else "Organization". */
fun secretOwnerTag(name: String, d: WorkDraft, pickable: List<PickableSecret>): String {
    val mine = pickable.any { it.name == name && it.owner == PickableSecret.Owner.ME }
    val org = pickable.any { it.name == name && it.owner == PickableSecret.Owner.WORKSPACE }
    return when {
        mine && (d.owner == WorkOwner.ME || !org) -> WorkOwner.ME.label
        org -> WorkOwner.WORKSPACE.label
        else -> "Not found"
    }
}

/**
 * Why "Organization" can't be picked right now: org work may only use org providers and secrets.
 * Null when it can.
 */
fun organizationDisabled(d: WorkDraft, providers: List<ModelProvider>, pickable: List<PickableSecret>): String? {
    val p = pickedProvider(d, providers)
    if (p != null && !p.isOrganization) return "${p.name} is your own provider — pick an Organization one or Default first."
    val personal = d.podSecrets.orEmpty().filter { name ->
        pickable.none { it.name == name && it.owner == PickableSecret.Owner.WORKSPACE } &&
            pickable.any { it.name == name && it.owner == PickableSecret.Owner.ME }
    }
    if (personal.isNotEmpty()) return "${personal.joinToString(", ")} ${if (personal.size == 1) "is" else "are"} your own — remove ${if (personal.size == 1) "it" else "them"} first."
    return null
}

/**
 * Editing someone else's personal work: why the form is read-only. Null for org work, your own,
 * or new work.
 */
fun foreignOwnerReason(ownerUserId: String?, meId: String?, ownerName: String?): String? {
    if (ownerUserId.isNullOrEmpty() || meId == null || ownerUserId == meId) return null
    return "Only ${ownerName ?: "its owner"} can change this — it runs with their credentials."
}
