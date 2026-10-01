package dev.optio.core.network

import dev.optio.core.model.CreateModelProviderInput
import dev.optio.core.model.ModelProvider
import dev.optio.core.model.ModelProviderAgent
import dev.optio.core.model.ModelProviderCredentials
import dev.optio.core.model.ModelProviderModel
import dev.optio.core.model.ModelProviderPodCredential
import dev.optio.core.model.OptioJson
import dev.optio.core.model.PickableSecret
import dev.optio.core.model.ResourceOwner
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put

// Model providers (Amazon Bedrock for Claude Code / Codex) and the secrets a piece of work can pick
// for its pod: the endpoints the work form and Settings › Model providers share, plus the pure
// helpers `@optio/shared`'s `model-provider.ts` exports (ported, since the generator emits types
// only).

/** The agent-options key that selects a model provider for a run (`MODEL_PROVIDER_OPTION_KEY`). */
const val MODEL_PROVIDER_OPTION_KEY = "modelProvider"

@Serializable
private data class ProvidersEnvelope(val providers: List<ModelProvider> = emptyList())

@Serializable
private data class ProviderEnvelope(val provider: ModelProvider)

@Serializable
private data class PickableEnvelope(val secrets: List<PickableSecret> = emptyList())

// region Endpoints

/** `GET /api/model-providers`: the org's providers, the caller's own, and (admins) others' by name. */
suspend fun ApiClient.listModelProviders(): List<ModelProvider> = get<ProvidersEnvelope>("/api/model-providers").providers

/** `POST /api/model-providers` (`owner: "workspace"` needs an admin). */
suspend fun ApiClient.createModelProvider(body: JsonObject): ModelProvider =
    post<ProviderEnvelope>("/api/model-providers", body).provider

/** `PATCH /api/model-providers/:id`: `credentials: null` clears stored credentials, absent keeps them. */
suspend fun ApiClient.updateModelProvider(id: String, body: JsonObject): ModelProvider =
    patch<ProviderEnvelope>("/api/model-providers/$id", body).provider

/** `DELETE /api/model-providers/:id`. */
suspend fun ApiClient.deleteModelProvider(id: String) {
    delete("/api/model-providers/$id")
}

/** `GET /api/secrets/pickable`: org (global) secret names and the caller's own. Never values. */
suspend fun ApiClient.listPickableSecrets(): List<PickableSecret> = get<PickableEnvelope>("/api/secrets/pickable").secrets

/** `POST /api/secrets`: a personal secret (`scope: "user"`) or, for admins, an org one. */
suspend fun ApiClient.createPickableSecret(name: String, value: String, personal: Boolean) {
    val body = buildJsonObject {
        put("name", name)
        put("value", value)
        if (personal) put("scope", "user")
    }
    post("/api/secrets", body)
}

// endregion

// region Reading a provider

/** The models a provider offers [agent] (`claude-code` / `codex`), in picker order; the first is the default. */
fun ModelProvider.modelsFor(agent: String): List<ModelProviderModel> {
    val list = when (agent) {
        "claude-code" -> models.claudeCode
        "codex" -> models.codex
        else -> null
    }
    return list.orEmpty().filter { it.id.isNotBlank() }
}

/** Whether the provider serves the runtime (`claude-code` / `codex`). */
fun ModelProvider.serves(runtime: String): Boolean = agents.any { it.raw == runtime }

/** Organization-owned (every member may pick it). */
val ModelProvider.isOrganization: Boolean
    get() = ownerUserId == null

/** "Organization" / "Just me" / "<name>'s". */
val ModelProvider.ownerLabel: String
    get() = when {
        isOrganization -> "Organization"
        mine -> "Just me"
        else -> ownerName?.let { "$it's" } ?: "Someone's"
    }

/** "Pods: access key" etc. */
fun podCredentialLabel(kind: ModelProviderPodCredential): String = when (kind) {
    ModelProviderPodCredential.ACCESS_KEY -> "access key"
    ModelProviderPodCredential.BEARER_TOKEN -> "API key"
    ModelProviderPodCredential.AMBIENT -> "IAM role"
    ModelProviderPodCredential.NONE -> "machines only"
    ModelProviderPodCredential.UNKNOWN -> "unknown"
}

/** "Claude Code" / "Codex". */
fun providerAgentLabel(agent: ModelProviderAgent): String = when (agent) {
    ModelProviderAgent.CLAUDE_CODE -> "Claude Code"
    ModelProviderAgent.CODEX -> "Codex"
    ModelProviderAgent.UNKNOWN -> "Unknown"
}

/** The provider an agent-options map picks, if any (`modelProviderIdFrom`). */
fun modelProviderIdFrom(agentOptions: Map<String, JsonElement>?): String? =
    (agentOptions?.get(MODEL_PROVIDER_OPTION_KEY) as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.ifEmpty { null }

// endregion

// region Shared helpers (ports of model-provider.ts)

private val AWS_REGION = Regex("^[a-z]{2}(-[a-z]+)+-\\d+$")
private val AWS_PROFILE = Regex("^[A-Za-z0-9._+=@-]{1,64}$")

fun isValidAwsRegion(region: String): Boolean = AWS_REGION.matches(region)

fun isValidAwsProfileName(name: String): Boolean = AWS_PROFILE.matches(name)

/** The cross-region inference prefix Bedrock uses for Anthropic models in a region. */
fun bedrockInferencePrefix(region: String): String = when {
    region.startsWith("us-gov-") -> "us-gov"
    region.startsWith("us-") || region.startsWith("ca-") -> "us"
    region.startsWith("eu-") -> "eu"
    region.startsWith("ap-") -> "apac"
    else -> "global"
}

/** Suggested models for a new Bedrock provider (editable). */
fun bedrockDefaultModels(agent: ModelProviderAgent, region: String): List<ModelProviderModel> {
    if (agent == ModelProviderAgent.CODEX) {
        return listOf(ModelProviderModel("openai.gpt-5.5", "GPT-5.5"), ModelProviderModel("openai.gpt-5.4", "GPT-5.4"))
    }
    val p = bedrockInferencePrefix(region)
    return listOf(
        ModelProviderModel("$p.anthropic.claude-opus-5-5", "Opus 5.5"),
        ModelProviderModel("$p.anthropic.claude-sonnet-5", "Sonnet 5"),
        ModelProviderModel("$p.anthropic.claude-fable-5-1", "Fable 5.1"),
        ModelProviderModel("$p.anthropic.claude-haiku-4-5-20251001-v1:0", "Haiku 4.5"),
    )
}

// endregion

// region Request bodies

/** What happens to the stored pod credentials on a save. */
sealed interface CredentialChange {
    /** Leave them (the key is omitted). */
    data object Keep : CredentialChange

    /** Clear them (`credentials: null`). */
    data object Clear : CredentialChange

    data class Replace(val credentials: ModelProviderCredentials) : CredentialChange
}

/**
 * A create / update body. [kind] is sent on create only (`UpdateModelProviderInput` omits it);
 * [credentials] distinguishes absent (keep) from null (clear), which the generated
 * [CreateModelProviderInput] (nulls omitted) cannot.
 */
fun modelProviderBody(
    name: String,
    owner: ResourceOwner,
    agents: List<ModelProviderAgent>,
    region: String,
    models: Map<ModelProviderAgent, List<ModelProviderModel>>,
    localAwsProfile: String?,
    podCredential: ModelProviderPodCredential,
    credentials: CredentialChange,
    create: Boolean,
): JsonObject = buildJsonObject {
    put("name", name.trim())
    put("owner", owner.raw)
    if (create) put("kind", "bedrock")
    put("agents", JsonArray(agents.map { JsonPrimitive(it.raw) }))
    put("region", region.trim())
    put(
        "models",
        JsonObject(
            agents.associate { agent ->
                agent.raw to JsonArray(
                    models[agent].orEmpty().filter { it.id.isNotBlank() }.map { m ->
                        buildJsonObject {
                            put("id", m.id.trim())
                            m.label?.trim()?.takeIf { it.isNotEmpty() }?.let { put("label", it) }
                        }
                    },
                )
            },
        ),
    )
    put("localAwsProfile", localAwsProfile?.trim()?.ifEmpty { null }?.let(::JsonPrimitive) ?: JsonNull)
    put("podCredential", podCredential.raw)
    when (credentials) {
        CredentialChange.Keep -> Unit
        CredentialChange.Clear -> put("credentials", JsonNull)
        is CredentialChange.Replace -> put("credentials", OptioJson.encodeToJsonElement(ModelProviderCredentials.serializer(), credentials.credentials))
    }
}

// endregion
