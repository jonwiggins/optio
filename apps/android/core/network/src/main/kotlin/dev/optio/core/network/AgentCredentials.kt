package dev.optio.core.network

import dev.optio.core.model.AgentCredential
import dev.optio.core.model.AgentCredentialOptions
import dev.optio.core.model.CreateAgentCredentialInput
import dev.optio.core.model.OptioJson
import dev.optio.core.model.ResourceOwner
import dev.optio.core.model.VerifyAgentCredentialInput
import dev.optio.core.model.VerifyAgentCredentialResult
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

// Agent credentials: how an agent CLI signs in for a piece of pod work — the agent's sign-in
// secrets (an API key, an OAuth token, a Codex app-server) and model providers (Bedrock) in one
// list (`@optio/shared`'s `agent-credential.ts`). The Who card's "Signed in with" control.

/** The agent-options key that holds a picked secret credential (`AGENT_CREDENTIAL_OPTION_KEY`). */
const val AGENT_CREDENTIAL_OPTION_KEY = "credential"

private val SECRET_CREDENTIAL = Regex("^secret:([0-9a-fA-F-]{36})$")

@Serializable
private data class CredentialEnvelope(val credential: AgentCredential)

// region Endpoints

/** `GET /api/agents/credentials?agentType=&owner=`: the organization's and the caller's own, plus what `+` can add. */
suspend fun ApiClient.listAgentCredentials(agentType: String, owner: ResourceOwner): AgentCredentialOptions =
    get("/api/agents/credentials", mapOf("agentType" to agentType, "owner" to owner.raw))

/** `POST /api/agents/credentials`: stores the value as the agent's secret (`owner: workspace` needs an admin) and returns the credential. */
suspend fun ApiClient.createAgentCredential(input: CreateAgentCredentialInput): AgentCredential =
    post<CredentialEnvelope>(
        "/api/agents/credentials",
        OptioJson.encodeToJsonElement(CreateAgentCredentialInput.serializer(), input),
    ).credential

/** `POST /api/agents/credentials/verify`: checks a value against its service without storing it. */
suspend fun ApiClient.verifyAgentCredential(input: VerifyAgentCredentialInput): VerifyAgentCredentialResult =
    post<VerifyAgentCredentialResult>(
        "/api/agents/credentials/verify",
        OptioJson.encodeToJsonElement(VerifyAgentCredentialInput.serializer(), input),
    )

// endregion

// region Shared helpers (ports of agent-credential.ts)

/** The `credential` value for a secret row (`secretCredentialId`). */
fun secretCredentialId(secretId: String): String = "secret:$secretId"

/** The secret row id a `credential` value names, or null when it is not a secret credential (`secretIdFromCredential`). */
fun secretIdFromCredential(value: String?): String? =
    value?.trim()?.let { SECRET_CREDENTIAL.find(it)?.groupValues?.get(1) }

/** The credential an agent-options map picks, if any. */
fun credentialIdFrom(agentOptions: Map<String, JsonElement>?): String? =
    (agentOptions?.get(AGENT_CREDENTIAL_OPTION_KEY) as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.ifEmpty { null }

// endregion
