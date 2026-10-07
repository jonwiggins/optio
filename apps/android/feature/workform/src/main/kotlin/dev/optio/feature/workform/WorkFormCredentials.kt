package dev.optio.feature.workform

import dev.optio.core.model.AgentCredential
import dev.optio.core.model.AgentCredentialKind
import dev.optio.core.model.AgentCredentialMethod
import dev.optio.core.model.LocalHost
import dev.optio.core.model.ModelProvider
import dev.optio.core.model.ResourceOwner
import dev.optio.core.network.AGENT_CREDENTIAL_OPTION_KEY
import dev.optio.core.network.MODEL_PROVIDER_OPTION_KEY
import dev.optio.core.ui.agent.OptionValue
import dev.optio.core.ui.agent.TERMINAL

// "Signed in with": the credential a piece of pod work runs with (the contract's "agent
// credentials"). A credential is one of the agent's sign-in secrets or a model provider; these
// are pure functions over the draft, on top of the provider helpers in WorkFormProviders.kt.

/**
 * The Signed-in-with control shows: pod work with an agent. A machine uses its own CLI login (it
 * keeps the Provider control); a pod session has no parameters.
 */
fun showsCredentials(d: WorkDraft): Boolean =
    !isLocal(d) && d.runtime != TERMINAL && deriveKind(d) != WorkKind.POD_SESSION

/** The credential id the draft picks: `secret:<id>` from `agentOptions.credential`, else the provider pick as `provider:<id>`. */
fun pickedCredentialId(d: WorkDraft): String? =
    d.agentOptions[AGENT_CREDENTIAL_OPTION_KEY]?.stringValue?.trim()?.ifEmpty { null }
        ?: pickedProviderId(d)?.let { "provider:$it" }

/** The picked credential among [credentials] (null for Default, or one this viewer can't see). */
fun pickedCredential(d: WorkDraft, credentials: List<AgentCredential>): AgentCredential? =
    pickedCredentialId(d)?.let { id -> credentials.firstOrNull { it.id == id } }

/** The credentials the control offers: the organization's and the viewer's own. Nothing where it is hidden. */
fun usableCredentials(d: WorkDraft, credentials: List<AgentCredential>): List<AgentCredential> {
    if (!showsCredentials(d)) return emptyList()
    return credentials.filter { it.owner == ResourceOwner.WORKSPACE || it.owner == ResourceOwner.ME }
}

/** Why [c] can't be picked here, if it can't: its provider is set up for machines only. */
fun credentialDisabled(c: AgentCredential, d: WorkDraft, providers: List<ModelProvider>, host: LocalHost?): String? {
    if (c.kind != AgentCredentialKind.PROVIDER) return null
    val p = providers.firstOrNull { it.id == c.providerId } ?: return null
    return providerDisabled(p, d, host)
}

/**
 * Picks [c] (null = Default). A provider is the provider pick (`modelProvider` and its first
 * model); a secret sets `credential` and drops any provider with its model; Default drops both.
 * A private credential on pod work makes the work private.
 */
fun withCredential(d: WorkDraft, c: AgentCredential?, providers: List<ModelProvider>, catalogModelField: String? = null): WorkDraft {
    val cleared = withProvider(d, null, catalogModelField).let { next ->
        if (AGENT_CREDENTIAL_OPTION_KEY !in next.agentOptions) next else next.copy(agentOptions = next.agentOptions - AGENT_CREDENTIAL_OPTION_KEY)
    }
    if (c == null) return cleared
    val private = c.owner == ResourceOwner.ME && !isLocal(d)
    if (c.kind == AgentCredentialKind.PROVIDER) {
        val p = providers.firstOrNull { it.id == c.providerId }
        if (p != null) return withProvider(cleared, p, catalogModelField)
        // The provider list hasn't arrived yet: pick it by id; the models follow when it does.
        val options = LinkedHashMap(cleared.agentOptions)
        options[MODEL_PROVIDER_OPTION_KEY] = OptionValue.Str(c.providerId.orEmpty())
        return cleared.copy(agentOptions = options, owner = if (private) WorkOwner.ME else cleared.owner)
    }
    val options = LinkedHashMap(cleared.agentOptions)
    options[AGENT_CREDENTIAL_OPTION_KEY] = OptionValue.Str(c.id)
    return cleared.copy(agentOptions = options, owner = if (private) WorkOwner.ME else cleared.owner)
}

/** "Organization" / "Private" / "Private · <name>" for a credential. */
fun credentialOwnerLabel(c: AgentCredential): String = when (c.owner) {
    ResourceOwner.ME -> WorkOwner.ME.label
    ResourceOwner.WORKSPACE -> WorkOwner.WORKSPACE.label
    else -> "Private · ${c.ownerName ?: "someone"}"
}

/** "API key" / "OAuth token" / … for a method. */
fun credentialMethodLabel(method: AgentCredentialMethod): String = when (method) {
    AgentCredentialMethod.API_KEY -> "API key"
    AgentCredentialMethod.OAUTH_TOKEN -> "OAuth token"
    AgentCredentialMethod.APP_SERVER -> "App server"
    AgentCredentialMethod.GITHUB_TOKEN -> "GitHub token"
    AgentCredentialMethod.VERTEX_AI -> "Vertex AI"
    AgentCredentialMethod.BEDROCK -> "Amazon Bedrock"
    AgentCredentialMethod.UNKNOWN -> "Credential"
}

/** The menu subtitle: owner, method, and "default" for the one a run uses with no pick. */
fun credentialSubtitle(c: AgentCredential): String =
    listOfNotNull(credentialOwnerLabel(c), credentialMethodLabel(c.method), "default".takeIf { c.default }).joinToString(" · ")

/** The control's value: "Default", or the picked credential's label, "(private)" when it is yours. */
fun credentialValueLabel(c: AgentCredential?): String = when {
    c == null -> "Default"
    c.owner == ResourceOwner.ME -> "${c.label} (private)"
    else -> c.label
}

/** Why "Organization" can't be picked: a private secret credential is picked (a private provider is [organizationDisabled]'s own check). */
fun privateCredentialReason(d: WorkDraft, credentials: List<AgentCredential>): String? {
    val c = pickedCredential(d, credentials) ?: return null
    if (c.kind != AgentCredentialKind.SECRET || c.owner != ResourceOwner.ME) return null
    return "${c.label} is your own credential — pick an Organization one or Default first."
}
