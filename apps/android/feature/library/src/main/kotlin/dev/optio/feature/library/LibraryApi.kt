package dev.optio.feature.library

import dev.optio.core.model.arrayValue
import dev.optio.core.model.get
import dev.optio.core.model.isNull
import dev.optio.core.model.objectValue
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

// The Library's endpoints (the prompt, repo, shared-directory, MCP and connection parts of iOS
// `Features/More/MoreAPI.swift`). Their responses are enriched or loosely typed on the server
// (`z.unknown()` schemas), so, like iOS, the rows are declared here with every field optional:
// a server that adds or drops a column never breaks decoding. Dates stay ISO strings (iOS keeps
// them as `String?` too) and are parsed only for display.

// region Prompts

/** A named prompt template (`prompt_templates` row). */
@Serializable
data class PromptTemplateRow(
    val id: String,
    val name: String,
    val template: String? = null,
    val kind: String? = null,
    val description: String? = null,
    val paramsSchema: JsonElement? = null,
    val defaultAgentType: String? = null,
    val isDefault: Boolean? = null,
    val repoUrl: String? = null,
    val workspaceId: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
) {
    /** Parameter names declared in `paramsSchema.properties`, else the `{{param}}` tokens of the body. */
    val paramNames: List<String>
        get() {
            val declared = paramsSchema?.get("properties")?.objectValue
            if (!declared.isNullOrEmpty()) return declared.keys.sorted()
            return templateParamNames(template.orEmpty())
        }
}

/**
 * The `{{param}}` names in [body] (iOS `PromptTemplateRow.paramNames`): `{{#if flag}}` counts as
 * `flag`, closing tags and other `#` helpers are skipped. Sorted, without duplicates.
 */
fun templateParamNames(body: String): List<String> {
    val names = sortedSetOf<String>()
    var rest = body
    while (true) {
        val open = rest.indexOf("{{")
        if (open < 0) break
        rest = rest.substring(open + 2)
        val close = rest.indexOf("}}")
        if (close < 0) break
        var token = rest.substring(0, close).trim(' ', '\t')
        rest = rest.substring(close + 2)
        if (token.startsWith("#if ")) token = token.removePrefix("#if ")
        if (token.startsWith("/") || token.startsWith("#") || token.isEmpty()) continue
        names += token
    }
    return names.toList()
}

/** Body of `POST /api/prompt-templates/named`. */
@Serializable
data class PromptTemplateInput(
    val name: String,
    val template: String,
    val kind: String,
    val description: String? = null,
    val defaultAgentType: String? = null,
) {
    /**
     * The PATCH body for an edit. Unlike a create, a cleared description or default agent is sent
     * as an explicit `null` so the server clears it (iOS omits it, so a cleared value came back).
     */
    fun patchBody(): Map<String, Any?> = mapOf(
        "name" to name,
        "template" to template,
        "kind" to kind,
        "description" to description,
        "defaultAgentType" to defaultAgentType,
    )
}

@Serializable
private data class TemplatesEnvelope(val templates: List<PromptTemplateRow> = emptyList())

@Serializable
private data class TemplateEnvelope(val template: PromptTemplateRow)

@Serializable
private data class PreviewBody(val params: Map<String, String>)

@Serializable
private data class PreviewResponse(val rendered: String)

suspend fun ApiClient.listPromptTemplates(kind: String? = null): List<PromptTemplateRow> =
    get<TemplatesEnvelope>("/api/prompt-templates", mapOf("kind" to kind)).templates

suspend fun ApiClient.createPromptTemplate(input: PromptTemplateInput): PromptTemplateRow =
    post<TemplateEnvelope>("/api/prompt-templates/named", input).template

suspend fun ApiClient.updatePromptTemplate(id: String, input: PromptTemplateInput): PromptTemplateRow =
    patch<TemplateEnvelope>("/api/prompt-templates/$id", input.patchBody()).template

suspend fun ApiClient.deletePromptTemplate(id: String) = delete("/api/prompt-templates/$id")

suspend fun ApiClient.previewPromptTemplate(id: String, params: Map<String, String>): String =
    post<PreviewResponse>("/api/prompt-templates/$id/preview", PreviewBody(params)).rendered

// endregion

// region Repos

/** A repository row (`GET /api/repos`, `GET /api/repos/:id` adds the effective review fields). */
@Serializable
data class RepoRow(
    val id: String,
    val repoUrl: String? = null,
    val gitPlatform: String? = null,
    val fullName: String? = null,
    val defaultBranch: String? = null,
    val isPrivate: Boolean? = null,
    val imagePreset: String? = null,
    val extraPackages: String? = null,
    val setupCommands: String? = null,
    val customDockerfile: String? = null,
    val autoMerge: Boolean? = null,
    val cautiousMode: Boolean? = null,
    val defaultAgentType: String? = null,
    val promptTemplateOverride: String? = null,
    val claudeModel: String? = null,
    val claudeContextWindow: String? = null,
    val claudeThinking: Boolean? = null,
    val claudeEffort: String? = null,
    val maxTurnsCoding: Int? = null,
    val maxTurnsReview: Int? = null,
    val autoResume: Boolean? = null,
    val planningModeEnabled: Boolean? = null,
    val maxConcurrentTasks: Int? = null,
    val maxPodInstances: Int? = null,
    val maxAgentsPerPod: Int? = null,
    val reviewEnabled: Boolean? = null,
    val reviewTrigger: String? = null,
    val testCommand: String? = null,
    val reviewAgentType: String? = null,
    val reviewModel: String? = null,
    val effectiveReviewAgentType: String? = null,
    val effectiveReviewModel: String? = null,
    val externalReviewMode: String? = null,
    val externalReviewWaitForCi: Boolean? = null,
    val maxAutoResumes: Int? = null,
    val networkPolicy: String? = null,
    val secretProxy: Boolean? = null,
    val offPeakOnly: Boolean? = null,
    val cpuRequest: String? = null,
    val cpuLimit: String? = null,
    val memoryRequest: String? = null,
    val memoryLimit: String? = null,
    val dockerInDocker: Boolean? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
) {
    val displayName: String
        get() = fullName ?: repoUrl ?: id
}

/** Body of `POST /api/repos`. */
@Serializable
data class RepoCreateInput(
    val repoUrl: String,
    val fullName: String,
    val defaultBranch: String? = null,
    val isPrivate: Boolean? = null,
)

/** `POST /api/setup/validate/repo`. */
@Serializable
data class RepoValidation(
    val valid: Boolean = false,
    val error: String? = null,
    val repo: Info? = null,
) {
    @Serializable
    data class Info(
        val fullName: String? = null,
        val defaultBranch: String? = null,
        val isPrivate: Boolean? = null,
    )
}

/** A shared cache directory (per-repo PVC). */
@Serializable
data class SharedDirectoryRow(
    val id: String,
    val repoId: String? = null,
    val name: String? = null,
    val description: String? = null,
    val mountLocation: String? = null,
    val mountSubPath: String? = null,
    val sizeGi: Int? = null,
    val scope: String? = null,
    val lastClearedAt: String? = null,
    val lastMountedAt: String? = null,
    val createdAt: String? = null,
)

/** Body of `POST /api/repos/:id/shared-directories`. */
@Serializable
data class SharedDirectoryInput(
    val name: String,
    val description: String? = null,
    val mountLocation: String,
    val mountSubPath: String,
    val sizeGi: Int? = null,
)

/** An MCP server, global or scoped to a repo. `env` is not decoded: it may carry secret values. */
@Serializable
data class McpServerRow(
    val id: String,
    val name: String? = null,
    val command: String? = null,
    val args: List<String>? = null,
    val installCommand: String? = null,
    val scope: String? = null,
    val repoUrl: String? = null,
    val enabled: Boolean? = null,
    val createdAt: String? = null,
) {
    /** `command args…`, the line under the server's name. */
    val commandLine: String
        get() = (listOf(command.orEmpty()) + args.orEmpty()).joinToString(" ").trim()

    val isGlobal: Boolean
        get() = scope == null || scope == "global"
}

/** Body of `POST /api/mcp-servers` and `POST /api/repos/:id/mcp-servers`. */
@Serializable
data class McpServerInput(
    val name: String,
    val command: String,
    val args: List<String>? = null,
    val env: Map<String, String>? = null,
    val installCommand: String? = null,
    val repoUrl: String? = null,
)

@Serializable
private data class ReposEnvelope(val repos: List<RepoRow> = emptyList())

@Serializable
private data class RepoEnvelope(val repo: RepoRow)

@Serializable
private data class RepoUrlBody(val repoUrl: String)

@Serializable
private data class RecycleResponse(val ok: Boolean? = null, val recycled: Int? = null)

@Serializable
private data class DirectoriesEnvelope(val directories: List<SharedDirectoryRow> = emptyList())

@Serializable
private data class UsageEnvelope(val usage: JsonElement? = null)

@Serializable
private data class ServersEnvelope(val servers: List<McpServerRow> = emptyList())

@Serializable
private data class EnabledBody(val enabled: Boolean)

suspend fun ApiClient.listRepos(): List<RepoRow> = get<ReposEnvelope>("/api/repos").repos

suspend fun ApiClient.getRepo(id: String): RepoRow = get<RepoEnvelope>("/api/repos/$id").repo

suspend fun ApiClient.createRepo(input: RepoCreateInput): RepoRow = post<RepoEnvelope>("/api/repos", input).repo

/** PATCH `/api/repos/:id`: [patch] may carry explicit nulls (e.g. `reviewAgentType` = inherit). */
suspend fun ApiClient.updateRepo(id: String, patch: Map<String, Any?>): RepoRow =
    patch<RepoEnvelope>("/api/repos/$id", patch).repo

suspend fun ApiClient.deleteRepo(id: String) = delete("/api/repos/$id")

suspend fun ApiClient.validateRepo(url: String): RepoValidation =
    post<RepoValidation>("/api/setup/validate/repo", RepoUrlBody(url))

/** Destroys the repo's idle ready pods; returns how many went. */
suspend fun ApiClient.recycleRepoPods(id: String): Int =
    post<RecycleResponse>("/api/repos/$id/pods/recycle").recycled ?: 0

suspend fun ApiClient.listSharedDirectories(repoId: String): List<SharedDirectoryRow> =
    get<DirectoriesEnvelope>("/api/repos/$repoId/shared-directories").directories

suspend fun ApiClient.createSharedDirectory(repoId: String, input: SharedDirectoryInput) =
    post("/api/repos/$repoId/shared-directories", input)

suspend fun ApiClient.deleteSharedDirectory(repoId: String, dirId: String) =
    delete("/api/repos/$repoId/shared-directories/$dirId")

suspend fun ApiClient.clearSharedDirectory(repoId: String, dirId: String) =
    post("/api/repos/$repoId/shared-directories/$dirId/clear")

/** The directory's usage as text (`du` output), or null when the server couldn't measure it. */
suspend fun ApiClient.sharedDirectoryUsage(repoId: String, dirId: String): String? {
    val usage = post<UsageEnvelope>("/api/repos/$repoId/shared-directories/$dirId/usage").usage
    return usageText(usage)
}

/** iOS: `usage.stringValue ?? usage.description`; null / JSON null → null. */
internal fun usageText(usage: JsonElement?): String? {
    if (usage == null || usage.isNull) return null
    return usage.stringValue ?: usage.toString()
}

suspend fun ApiClient.listRepoConnections(repoId: String): List<ConnectionRow> =
    get<ConnectionsEnvelope>("/api/repos/$repoId/connections").connections

suspend fun ApiClient.listRepoMcpServers(repoId: String): List<McpServerRow> =
    get<ServersEnvelope>("/api/repos/$repoId/mcp-servers").servers

suspend fun ApiClient.createRepoMcpServer(repoId: String, input: McpServerInput) =
    post("/api/repos/$repoId/mcp-servers", input)

suspend fun ApiClient.listMcpServers(scope: String? = null): List<McpServerRow> =
    get<ServersEnvelope>("/api/mcp-servers", mapOf("scope" to scope)).servers

suspend fun ApiClient.createMcpServer(input: McpServerInput) = post("/api/mcp-servers", input)

suspend fun ApiClient.setMcpServerEnabled(id: String, enabled: Boolean) =
    patch<Unit>("/api/mcp-servers/$id", EnabledBody(enabled))

suspend fun ApiClient.deleteMcpServer(id: String) = delete("/api/mcp-servers/$id")

// endregion

// region Connections

/** A catalog entry (`GET /api/connection-providers`). */
@Serializable
data class ConnectionProviderRow(
    val id: String,
    val slug: String? = null,
    val name: String? = null,
    val description: String? = null,
    val icon: String? = null,
    val category: String? = null,
    val type: String? = null,
    val configSchema: JsonElement? = null,
    val requiredSecrets: List<String>? = null,
    val capabilities: List<String>? = null,
    val docsUrl: String? = null,
    val builtIn: Boolean? = null,
) {
    val displayName: String
        get() = name ?: slug ?: id

    /** One input of the setup form, from the provider's JSON-Schema `configSchema`. */
    data class ConfigField(
        val key: String,
        val title: String,
        val placeholder: String?,
        val isSecret: Boolean,
        val required: Boolean,
        /** `enum` values: the field is a picker. */
        val options: List<String> = emptyList(),
        /** "one per line" fields take several lines. */
        val multiline: Boolean = false,
    )

    /**
     * The setup form's fields (iOS `configFields`): `title` (else the key), `placeholder` (else the
     * schema `default`, as a hint), `format: "secret"` → masked, `required`, `enum` → a picker.
     * Required fields come first; within each group the server's order is kept (iOS sorts keys
     * because Swift dictionaries have no order).
     */
    val configFields: List<ConfigField>
        get() {
            val props = configSchema?.get("properties")?.objectValue ?: return emptyList()
            val required = configSchema["required"]?.arrayValue?.mapNotNull { it.stringValue }?.toSet().orEmpty()
            return props.map { (key, schema) ->
                val title = schema["title"]?.stringValue ?: key
                ConfigField(
                    key = key,
                    title = title,
                    placeholder = schema["placeholder"]?.stringValue ?: schema["default"]?.let(::schemaDefaultText),
                    isSecret = schema["format"]?.stringValue == "secret",
                    required = key in required,
                    options = schema["enum"]?.arrayValue?.mapNotNull { it.stringValue }.orEmpty(),
                    multiline = title.contains("per line", ignoreCase = true),
                )
            }.sortedBy { !it.required }
        }
}

private fun schemaDefaultText(value: JsonElement): String? = when {
    value.isNull -> null
    value is JsonPrimitive -> value.content
    else -> value.toString()
}

/** A configured connection. `config` is deliberately not decoded: it may hold secret values. */
@Serializable
data class ConnectionRow(
    val id: String,
    val name: String? = null,
    val providerId: String? = null,
    val scope: String? = null,
    val repoUrl: String? = null,
    val enabled: Boolean? = null,
    val status: String? = null,
    val statusMessage: String? = null,
    val lastCheckedAt: String? = null,
    val createdAt: String? = null,
    val provider: ConnectionProviderRow? = null,
    val assignments: List<ConnectionAssignmentRow>? = null,
) {
    val displayName: String
        get() = name ?: id

    /** `healthy` / `connected`. */
    val isHealthy: Boolean
        get() = status == "healthy" || status == "connected"

    /** `error` / `failed`. */
    val isFailing: Boolean
        get() = status == "error" || status == "failed"
}

/** Which repos and agent types receive a connection, with what permission. */
@Serializable
data class ConnectionAssignmentRow(
    val id: String,
    val connectionId: String? = null,
    /** null = all repos. */
    val repoId: String? = null,
    /** empty / null = all agents. */
    val agentTypes: List<String>? = null,
    val permission: String? = null,
    val enabled: Boolean? = null,
    val createdAt: String? = null,
)

/** Body of `POST /api/connections`. */
@Serializable
data class ConnectionCreateInput(
    val providerId: String,
    val name: String,
    val config: Map<String, String>,
    val assignments: List<ConnectionAssignmentInput>,
)

/** One assignment (inline on create, or `POST /api/connections/:id/assignments`). */
@Serializable
data class ConnectionAssignmentInput(
    /** null = all repos (omitted on the wire). */
    val repoId: String? = null,
    /** empty = all agents. */
    val agentTypes: List<String>,
    val permission: String,
)

@Serializable
private data class ProvidersEnvelope(val providers: List<ConnectionProviderRow> = emptyList())

@Serializable
private data class ConnectionsEnvelope(val connections: List<ConnectionRow> = emptyList())

@Serializable
private data class ConnectionEnvelope(val connection: ConnectionRow)

@Serializable
private data class AssignmentsEnvelope(val assignments: List<ConnectionAssignmentRow> = emptyList())

suspend fun ApiClient.listConnectionProviders(): List<ConnectionProviderRow> =
    get<ProvidersEnvelope>("/api/connection-providers").providers

suspend fun ApiClient.listConnections(): List<ConnectionRow> = get<ConnectionsEnvelope>("/api/connections").connections

suspend fun ApiClient.getConnection(id: String): ConnectionRow = get<ConnectionEnvelope>("/api/connections/$id").connection

suspend fun ApiClient.createConnection(input: ConnectionCreateInput): ConnectionRow =
    post<ConnectionEnvelope>("/api/connections", input).connection

suspend fun ApiClient.setConnectionEnabled(id: String, enabled: Boolean) =
    patch<Unit>("/api/connections/$id", EnabledBody(enabled))

suspend fun ApiClient.deleteConnection(id: String) = delete("/api/connections/$id")

/** Marks the connection healthy / failed on the server and returns it. */
suspend fun ApiClient.testConnection(id: String): ConnectionRow =
    post<ConnectionEnvelope>("/api/connections/$id/test").connection

suspend fun ApiClient.listConnectionAssignments(connectionId: String): List<ConnectionAssignmentRow> =
    get<AssignmentsEnvelope>("/api/connections/$connectionId/assignments").assignments

suspend fun ApiClient.createConnectionAssignment(connectionId: String, input: ConnectionAssignmentInput) =
    post("/api/connections/$connectionId/assignments", input)

suspend fun ApiClient.deleteConnectionAssignment(id: String) = delete("/api/connection-assignments/$id")

// endregion
