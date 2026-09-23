package dev.optio.feature.workform

import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalHostDir
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// The endpoints the work form reads and writes (the web's `api-client.ts` calls behind
// `work-form.tsx`, `submit.ts` and `load.ts`; iOS `WorkFormState` / `WorkFormSubmitter`). Rows the
// server enriches or types loosely are read as `JsonObject`, like iOS's `[String: AnyCodable]`.

/**
 * A registered repo as the form needs it: the identity columns plus the raw row, so
 * [optionsFromRepo] can read whichever per-provider option columns the picked runtime's catalog
 * names (iOS `SessionFormRepo`).
 */
data class FormRepo(
    val id: String,
    val fullName: String,
    val repoUrl: String,
    val defaultBranch: String,
    val raw: JsonObject,
) {
    companion object {
        fun from(raw: JsonObject): FormRepo? {
            val id = raw["id"]?.stringValue ?: return null
            val repoUrl = raw["repoUrl"]?.stringValue ?: return null
            return FormRepo(
                id = id,
                fullName = raw["fullName"]?.stringValue ?: shortRepo(repoUrl),
                repoUrl = repoUrl,
                defaultBranch = raw["defaultBranch"]?.stringValue ?: "main",
                raw = raw,
            )
        }
    }
}

/** A saved prompt (`/api/prompt-templates`), for the "Saved prompts" menu. */
@Serializable
data class PromptTemplateRow(
    val id: String,
    val name: String,
    val template: String? = null,
    val kind: String? = null,
)

/** A task the new one can wait on (`/api/tasks`), for "Wait for". */
@Serializable
data class DependencyTaskRow(
    val id: String,
    val title: String,
    val state: String,
)

@Serializable
private data class ReposEnvelope(val repos: List<JsonObject> = emptyList())

@Serializable
private data class HostsEnvelope(val hosts: List<LocalHost> = emptyList())

@Serializable
private data class TemplatesEnvelope(val templates: List<PromptTemplateRow> = emptyList())

@Serializable
private data class TasksEnvelope(val tasks: List<DependencyTaskRow> = emptyList())

@Serializable
private data class CountEnvelope(val tasks: List<JsonElement> = emptyList(), val total: Int? = null)

@Serializable
private data class IdRow(val id: String)

@Serializable
private data class TaskIdEnvelope(val task: IdRow)

@Serializable
private data class RunEnvelope(val runId: String)

@Serializable
private data class BlueprintIdEnvelope(val blueprint: IdRow)

@Serializable
private data class TerminalIdEnvelope(val terminal: IdRow)

@Serializable
private data class SessionIdEnvelope(val session: IdRow)

@Serializable
private data class AgentIdEnvelope(val agent: IdRow)

@Serializable
private data class RowEnvelope(val task: JsonObject? = null, val blueprint: JsonObject? = null)

@Serializable
private data class TriggersEnvelope(val triggers: List<JsonObject> = emptyList())

// region Reads

/** `GET /api/repos` as raw rows (see [FormRepo]). */
suspend fun ApiClient.listFormRepos(): List<FormRepo> = get<ReposEnvelope>("/api/repos").repos.mapNotNull(FormRepo::from)

/** `GET /api/local/hosts`: the caller's paired machines. */
suspend fun ApiClient.listFormHosts(): List<LocalHost> = get<HostsEnvelope>("/api/local/hosts").hosts

/** `GET /api/prompt-templates`: every saved prompt. */
suspend fun ApiClient.listFormTemplates(): List<PromptTemplateRow> = get<TemplatesEnvelope>("/api/prompt-templates").templates

/** `GET /api/tasks?limit=100`: tasks a new one can depend on. */
suspend fun ApiClient.listDependencyTasks(): List<DependencyTaskRow> =
    get<TasksEnvelope>("/api/tasks", mapOf("limit" to 100)).tasks

/**
 * How many rows the unified list counts, for the "Job N" placeholder: `total`, or null when the
 * server does not send it (the web then falls back to a timestamp name).
 */
suspend fun ApiClient.workCount(): Int? = get<CountEnvelope>("/api/tasks", mapOf("type" to "all", "limit" to 1)).total

// endregion

// region Creates (submit.ts `createWork`)

/** `POST /api/tasks` (unified): a Repo Task, a scheduled blueprint, or a Job. Returns its id. */
suspend fun ApiClient.createTaskUnified(body: JsonObject): String = post<TaskIdEnvelope>("/api/tasks", body).task.id

/** `POST /api/tasks/:id/triggers`: a trigger on a blueprint or a Job. */
suspend fun ApiClient.createTaskTrigger(id: String, body: JsonObject) {
    post("/api/tasks/$id/triggers", body)
}

/** `POST /api/tasks/:id/runs`: run a Job now. Returns the run id. */
suspend fun ApiClient.createTaskRun(id: String): String =
    post<RunEnvelope>("/api/tasks/$id/runs", jsonObjectOf("params" to JsonObject(emptyMap()))).runId

/** `DELETE /api/task-configs/:id`: roll a scheduled Task back. */
suspend fun ApiClient.deleteTaskConfig(id: String) {
    delete("/api/task-configs/$id")
}

/** `DELETE /api/jobs/:id`: roll a Job back. */
suspend fun ApiClient.deleteWorkflow(id: String) {
    delete("/api/jobs/$id")
}

/** `POST /api/local/blueprints`: a Local automation. Returns its id. */
suspend fun ApiClient.createLocalBlueprint(body: JsonObject): String =
    post<BlueprintIdEnvelope>("/api/local/blueprints", body).blueprint.id

suspend fun ApiClient.createLocalBlueprintTrigger(id: String, body: JsonObject) {
    post("/api/local/blueprints/$id/triggers", body)
}

suspend fun ApiClient.deleteLocalBlueprint(id: String) {
    delete("/api/local/blueprints/$id")
}

/** `POST /api/local/terminals`: a terminal on a paired machine. Returns its id. */
suspend fun ApiClient.createLocalTerminal(body: JsonObject): String =
    post<TerminalIdEnvelope>("/api/local/terminals", body).terminal.id

/** `POST /api/sessions`: an interactive pod session. Returns its id. */
suspend fun ApiClient.createPodSession(body: JsonObject): String = post<SessionIdEnvelope>("/api/sessions", body).session.id

/** `POST /api/persistent-agents`. Returns the agent's id. */
suspend fun ApiClient.createPersistentAgent(body: JsonObject): String =
    post<AgentIdEnvelope>("/api/persistent-agents", body).agent.id

suspend fun ApiClient.createPersistentAgentTrigger(id: String, body: JsonObject) {
    post("/api/persistent-agents/$id/triggers", body)
}

suspend fun ApiClient.deletePersistentAgent(id: String) {
    delete("/api/persistent-agents/$id")
}

// endregion

// region Edits (load.ts / submit.ts `updateWork`)

/** `GET /api/tasks/:id`: resolves an id across tasks, task_configs and workflows (`type` tagged). */
suspend fun ApiClient.getTaskUnified(id: String): JsonObject =
    get<RowEnvelope>("/api/tasks/$id").task ?: error("No task in the response")

suspend fun ApiClient.listTaskTriggers(id: String): List<JsonObject> = get<TriggersEnvelope>("/api/tasks/$id/triggers").triggers

suspend fun ApiClient.getLocalBlueprint(id: String): JsonObject =
    get<RowEnvelope>("/api/local/blueprints/$id").blueprint ?: error("No automation in the response")

suspend fun ApiClient.listLocalBlueprintTriggers(id: String): List<JsonObject> =
    get<TriggersEnvelope>("/api/local/blueprints/$id/triggers").triggers

/** `PATCH /api/task-configs/:id`: a scheduled Task. */
suspend fun ApiClient.updateTaskConfig(id: String, body: JsonObject) {
    patch<Unit>("/api/task-configs/$id", body)
}

/** `PATCH /api/jobs/:id`: a Job. */
suspend fun ApiClient.updateWorkflow(id: String, body: JsonObject) {
    patch<Unit>("/api/jobs/$id", body)
}

suspend fun ApiClient.updateTaskTrigger(id: String, triggerId: String, body: JsonObject) {
    patch<Unit>("/api/tasks/$id/triggers/$triggerId", body)
}

suspend fun ApiClient.deleteTaskTrigger(id: String, triggerId: String) {
    delete("/api/tasks/$id/triggers/$triggerId")
}

/** `PATCH /api/local/blueprints/:id`: a Local automation. */
suspend fun ApiClient.updateLocalBlueprint(id: String, body: JsonObject) {
    patch<Unit>("/api/local/blueprints/$id", body)
}

suspend fun ApiClient.updateLocalBlueprintTrigger(id: String, triggerId: String, body: JsonObject) {
    patch<Unit>("/api/local/blueprints/$id/triggers/$triggerId", body)
}

suspend fun ApiClient.deleteLocalBlueprintTrigger(id: String, triggerId: String) {
    delete("/api/local/blueprints/$id/triggers/$triggerId")
}

// endregion

/** Which of a host's directories a run can use: a new branch / PR needs a git checkout. */
fun usableDir(withRepo: Boolean, dir: LocalHostDir): Boolean = !withRepo || dir.repoUrl != null
