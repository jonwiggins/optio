package dev.optio.feature.more.providers

import dev.optio.core.model.ModelProvider
import dev.optio.core.model.ModelProviderAgent
import dev.optio.core.model.ModelProviderCredentials
import dev.optio.core.model.ModelProviderModel
import dev.optio.core.model.ModelProviderPodCredential
import dev.optio.core.model.ResourceOwner
import dev.optio.core.network.CredentialChange
import dev.optio.core.network.bedrockDefaultModels
import dev.optio.core.network.isValidAwsProfileName
import dev.optio.core.network.isValidAwsRegion
import dev.optio.core.network.modelProviderBody
import dev.optio.core.network.modelsFor
import kotlinx.serialization.json.JsonObject

/** The editable agents, in the editor's order. */
val PROVIDER_AGENTS: List<ModelProviderAgent> = listOf(ModelProviderAgent.CLAUDE_CODE, ModelProviderAgent.CODEX)

/** The pod credential kinds the editor offers, with their labels. */
val POD_CREDENTIAL_CHOICES: List<Pair<ModelProviderPodCredential, String>> = listOf(
    ModelProviderPodCredential.ACCESS_KEY to "Access key",
    ModelProviderPodCredential.BEARER_TOKEN to "Bedrock API key",
    ModelProviderPodCredential.AMBIENT to "Pod's IAM role",
    ModelProviderPodCredential.NONE to "Machines only",
)

/** What the editor does with the stored pod credentials. */
enum class CredentialMode { KEEP, REPLACE, CLEAR }

/**
 * The provider editor's answers. Models are edited as text, one per line: `id` or `id | Label`.
 * Credentials are write-only: the editor never sees stored values, only [hasStored].
 */
data class ModelProviderDraft(
    val id: String? = null,
    val name: String = "",
    val owner: ResourceOwner = ResourceOwner.ME,
    val agents: Set<ModelProviderAgent> = setOf(ModelProviderAgent.CLAUDE_CODE),
    val region: String = DEFAULT_REGION,
    val models: Map<ModelProviderAgent, String> = PROVIDER_AGENTS.associateWith { modelsText(bedrockDefaultModels(it, DEFAULT_REGION)) },
    val localAwsProfile: String = "",
    val podCredential: ModelProviderPodCredential = ModelProviderPodCredential.ACCESS_KEY,
    val hasStored: Boolean = false,
    val credentialMode: CredentialMode = CredentialMode.REPLACE,
    val accessKeyId: String = "",
    val secretAccessKey: String = "",
    val sessionToken: String = "",
    val bearerToken: String = "",
) {
    val isNew: Boolean
        get() = id == null

    /** Whether the credential kind stores something on the server. */
    val storesCredentials: Boolean
        get() = podCredential == ModelProviderPodCredential.ACCESS_KEY || podCredential == ModelProviderPodCredential.BEARER_TOKEN

    /**
     * A new region: every model list still at the old region's suggestions follows to the new
     * one's (the Anthropic ids carry a region prefix); edited lists stay as typed.
     */
    fun withRegion(next: String): ModelProviderDraft {
        val updated = models.mapValues { (agent, text) ->
            if (text.trim() == modelsText(bedrockDefaultModels(agent, region))) modelsText(bedrockDefaultModels(agent, next.trim())) else text
        }
        return copy(region = next, models = updated)
    }

    /** What's wrong, if anything (null = ready to save). */
    fun problem(): String? {
        if (name.isBlank()) return "Name it."
        if (agents.isEmpty()) return "Pick at least one agent."
        if (!isValidAwsRegion(region.trim())) return "Region looks like us-west-2."
        val profile = localAwsProfile.trim()
        if (profile.isNotEmpty() && !isValidAwsProfileName(profile)) return "That isn't an AWS profile name."
        if (storesCredentials && credentialMode == CredentialMode.REPLACE && (isNew || hasStored || anyCredentialTyped)) {
            when (podCredential) {
                ModelProviderPodCredential.ACCESS_KEY ->
                    if (accessKeyId.isBlank() || secretAccessKey.isBlank()) return "Enter the access key id and secret."
                ModelProviderPodCredential.BEARER_TOKEN -> if (bearerToken.isBlank()) return "Enter the Bedrock API key."
                else -> Unit
            }
        }
        return null
    }

    private val anyCredentialTyped: Boolean
        get() = listOf(accessKeyId, secretAccessKey, sessionToken, bearerToken).any { it.isNotBlank() }

    /** The credential change the save sends. */
    fun credentialChange(): CredentialChange {
        if (!storesCredentials) return if (hasStored) CredentialChange.Clear else CredentialChange.Keep
        return when (credentialMode) {
            CredentialMode.KEEP -> CredentialChange.Keep
            CredentialMode.CLEAR -> CredentialChange.Clear
            CredentialMode.REPLACE -> when {
                podCredential == ModelProviderPodCredential.ACCESS_KEY && accessKeyId.isNotBlank() && secretAccessKey.isNotBlank() ->
                    CredentialChange.Replace(
                        ModelProviderCredentials.AccessKey(accessKeyId.trim(), secretAccessKey.trim(), sessionToken.trim().ifEmpty { null }),
                    )
                podCredential == ModelProviderPodCredential.BEARER_TOKEN && bearerToken.isNotBlank() ->
                    CredentialChange.Replace(ModelProviderCredentials.BearerToken(bearerToken.trim()))
                else -> CredentialChange.Keep
            }
        }
    }

    /** The create / update body. */
    fun body(): JsonObject {
        val picked = PROVIDER_AGENTS.filter { it in agents }
        return modelProviderBody(
            name = name,
            owner = owner,
            agents = picked,
            region = region,
            models = picked.associateWith { parseModels(models[it].orEmpty()) },
            localAwsProfile = localAwsProfile,
            podCredential = podCredential,
            credentials = credentialChange(),
            create = isNew,
        )
    }

    companion object {
        const val DEFAULT_REGION = "us-west-2"

        /** A new provider: personal unless [admin] (admins start at Organization). */
        fun new(admin: Boolean): ModelProviderDraft = ModelProviderDraft(owner = if (admin) ResourceOwner.WORKSPACE else ResourceOwner.ME)

        /** An existing provider, credentials kept unless replaced. */
        fun from(p: ModelProvider): ModelProviderDraft = ModelProviderDraft(
            id = p.id,
            name = p.name,
            owner = if (p.ownerUserId == null) ResourceOwner.WORKSPACE else ResourceOwner.ME,
            agents = p.agents.filter { it in PROVIDER_AGENTS }.toSet(),
            region = p.region,
            models = PROVIDER_AGENTS.associateWith { agent ->
                if (agent in p.agents) modelsText(p.modelsFor(agent.raw)) else modelsText(bedrockDefaultModels(agent, p.region))
            },
            localAwsProfile = p.localAwsProfile.orEmpty(),
            podCredential = p.podCredential.takeIf { it != ModelProviderPodCredential.UNKNOWN } ?: ModelProviderPodCredential.NONE,
            hasStored = p.hasPodCredentials,
            credentialMode = if (p.hasPodCredentials) CredentialMode.KEEP else CredentialMode.REPLACE,
        )
    }
}

/** Models as editor text: `id | Label` per line. */
fun modelsText(models: List<ModelProviderModel>): String =
    models.joinToString("\n") { m -> if (m.label.isNullOrBlank()) m.id else "${m.id} | ${m.label}" }

/** Editor text back to models: blank lines skipped, `id | Label` split. */
fun parseModels(text: String): List<ModelProviderModel> = text.lines().mapNotNull { line ->
    val id = line.substringBefore('|').trim()
    if (id.isEmpty()) return@mapNotNull null
    val label = line.substringAfter('|', "").trim().ifEmpty { null }
    ModelProviderModel(id, label)
}
