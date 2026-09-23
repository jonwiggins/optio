package dev.optio.feature.workform

import androidx.navigation3.runtime.NavKey
import dev.optio.core.model.stringValue
import dev.optio.core.navigation.routes.AgentDetailRoute
import dev.optio.core.navigation.routes.JobDetailRoute
import dev.optio.core.navigation.routes.JobRunRoute
import dev.optio.core.navigation.routes.LocalAutomationRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.navigation.routes.ScheduledDetailRoute
import dev.optio.core.navigation.routes.SessionDetailRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Port of `apps/web/src/components/work-form/submit.ts`: turn a draft into the row(s) its kind
// needs. Each branch calls the same endpoint the dedicated form for that kind calls, so nothing
// about how a Task, Job, automation, terminal or agent runs changes: only where you make it.

/** Where the app goes once the work exists: the detail [route] and the snackbar [toast]. */
data class Created(
    val kind: WorkKind,
    val route: NavKey,
    val toast: String,
)

/** A trigger row as `POST …/triggers` takes it. */
data class TriggerSpec(val type: String, val config: JsonObject) {
    /** `{ type, config, enabled: true }`. */
    val body: JsonObject
        get() = buildJsonObject {
            put("type", type)
            put("config", config)
            put("enabled", true)
        }
}

/**
 * The trigger row a draft asks for, if any: the same shape whatever kind of row it attaches to (a
 * schedule, a webhook, a ticket filter, or a GitHub / Slack / Linear event).
 */
fun triggerFor(d: WorkDraft): TriggerSpec? {
    d.whenType.event?.let { return TriggerSpec(it.raw, d.event.config) }
    val t = d.trigger
    return when (t.type) {
        TriggerType.MANUAL -> null
        TriggerType.SCHEDULE -> TriggerSpec("schedule", jsonObjectOf("cronExpression" to JsonPrimitive(t.cronExpression.orEmpty().trim())))
        TriggerType.WEBHOOK -> TriggerSpec("webhook", jsonObjectOf("path" to JsonPrimitive(t.webhookPath.orEmpty())))
        TriggerType.TICKET -> TriggerSpec(
            "ticket",
            buildJsonObject {
                put("source", (t.ticketSource ?: TicketSource.GITHUB).raw)
                val labels = t.ticketLabels.orEmpty()
                if (labels.isNotEmpty()) put("labels", JsonArray(labels.map(::JsonPrimitive)))
            },
        )
    }
}

/** The run-name template, or null for "runs take the definition's name". */
fun runNameFor(d: WorkDraft): String? = d.runName.trim().ifEmpty { null }

/** Only the options the user actually set (blank selects mean "default"); null when none. */
fun setOptions(d: WorkDraft): JsonObject? {
    val out = d.agentOptions.filterValues { !it.isBlank }.mapValues { it.value.json }
    return if (out.isEmpty()) null else JsonObject(out)
}

/** The model the draft picked for its runtime, for rows that carry just a model. */
fun pickedModel(d: WorkDraft): String? {
    if (d.runtime == TERMINAL) return null
    return d.agentOptions[modelFieldForRuntime(d.runtime)]?.stringValue?.ifEmpty { null }
}

/**
 * The run-location fields a create / update body carries (`runLocationPayload`): a pod spells
 * "none" as explicit nulls, exactly like the web.
 */
fun locationPayload(d: WorkDraft): JsonObject = if (d.location.runTarget != Where.LOCAL) {
    jsonObjectOf("runTarget" to JsonPrimitive("cluster"), "localHostId" to JsonNull, "localDir" to JsonNull, "localSessionMode" to JsonNull)
} else {
    jsonObjectOf(
        "runTarget" to JsonPrimitive("local"),
        "localHostId" to JsonPrimitive(d.location.localHostId),
        "localDir" to JsonPrimitive(d.location.localDir),
        "localSessionMode" to JsonPrimitive(d.location.localSessionMode.raw),
    )
}

private fun JsonObjectBuilder.putAll(obj: JsonObject) = obj.forEach { (k, v) -> put(k, v) }

private fun JsonObjectBuilder.putOrNull(key: String, value: String?) = put(key, value?.let(::JsonPrimitive) ?: JsonNull)

private fun JsonObjectBuilder.putOrNull(key: String, value: JsonObject?) = put(key, value ?: JsonNull)

/** The operator manual a new persistent agent ships with (web `defaultAgentsMd()`). */
val DEFAULT_AGENTS_MD: String = """
You are running as a Persistent Agent inside Optio. You can talk to other
agents in this workspace through Optio's HTTP API. Use the bash + curl
verbs below — there is no human waiting at a terminal, so design every
call to be non-interactive.

Environment variables (already set):
- OPTIO_API_URL          — base URL for Optio's API
- OPTIO_AGENT_TOKEN      — your bearer token (your own UUID)
- OPTIO_PERSISTENT_AGENT_SLUG — your own slug
- OPTIO_PERSISTENT_AGENT_TURN_ID — current turn id

## List addressable agents in your workspace

    curl -s -H "X-Optio-Agent-Token: ${'$'}OPTIO_AGENT_TOKEN" \
      "${'$'}OPTIO_API_URL/api/internal/persistent-agents"

## Send a direct message to another agent (by slug)

    curl -s -X POST -H "X-Optio-Agent-Token: ${'$'}OPTIO_AGENT_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"to":"forge","body":"Please implement spec X..."}' \
      "${'$'}OPTIO_API_URL/api/internal/persistent-agents/send"

## Broadcast to everyone in your workspace

    curl -s -X POST -H "X-Optio-Agent-Token: ${'$'}OPTIO_AGENT_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"body":"Heads up, the build is broken."}' \
      "${'$'}OPTIO_API_URL/api/internal/persistent-agents/broadcast"

## Read your own recent inbox

    curl -s -H "X-Optio-Agent-Token: ${'$'}OPTIO_AGENT_TOKEN" \
      "${'$'}OPTIO_API_URL/api/internal/persistent-agents/inbox?limit=20"

## Inbox messages you receive

Messages from other agents arrive in your prompt as structured blocks:

    ---BEGIN OPTIO MESSAGE---
    {"version":1,"timestamp":"...","sender":"agent:.../forge","type":"instruction","broadcasted":false,"body":"..."}
    ---END OPTIO MESSAGE---

Always read these carefully — they are your inputs.

## Halt

When you have nothing more to do this turn, simply finish your response.
Optio will mark the turn complete and you'll be re-woken on the next
message, webhook, or scheduled tick.
""".trimStart('\n')

/**
 * A failure after the row's own create succeeded (its trigger, its first run): never a name clash,
 * so [WorkFormSubmitter.create] must not retry it under another name.
 */
private class AfterCreate(val error: Throwable) : Exception(error)

/**
 * Runs the dispatch against the API (web `createWork` / `updateWork`). `repoUrl` is the effective
 * repo: a registered repo's URL on a pod, the checkout's normalized remote on a machine.
 */
class WorkFormSubmitter(private val api: ApiClient) {
    /**
     * Creates the work [d] describes. Jobs, scheduled Tasks and agents have unique names per
     * workspace, and "Job N" is only a count: on a name clash (409 on the row's own create) an
     * automatic name is bumped ("Job 4 (2)") and tried again, up to 5 times; the user's own name
     * surfaces as the error.
     */
    suspend fun create(d: WorkDraft, repoUrl: String, autoName: String): Created {
        val auto = d.name.isBlank()
        var attempt = 1
        while (true) {
            val name = if (auto && attempt > 1) "$autoName ($attempt)" else d.name.trim().ifEmpty { autoName }
            try {
                return createOnce(d, repoUrl, name)
            } catch (e: AfterCreate) {
                throw e.error
            } catch (e: ApiError) {
                if (!auto || e.status != 409 || attempt >= 5) throw e
            }
            attempt++
        }
    }

    /**
     * Creates the blueprint row, then its trigger. A rejected trigger (the API validates event
     * configs) deletes the row again so nothing half-made is left behind, and the error surfaces
     * to the form.
     */
    private suspend fun withTrigger(
        trigger: TriggerSpec?,
        create: suspend () -> String,
        attach: suspend (id: String, trigger: TriggerSpec) -> Unit,
        discard: suspend (id: String) -> Unit,
    ): String {
        val id = create()
        if (trigger == null) return id
        try {
            attach(id, trigger)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            try {
                discard(id)
            } catch (c: CancellationException) {
                throw c
            } catch (_: Exception) {
                // The trigger's error is the one to show.
            }
            throw AfterCreate(e)
        }
        return id
    }

    private suspend fun createOnce(d: WorkDraft, repoUrl: String, name: String): Created {
        val kind = deriveKind(d)
        val runName = runNameFor(d)
        val prompt = d.prompt.trim()
        val trigger = triggerFor(d)
        val location = locationPayload(d)
        val options = setOptions(d)
        val model = pickedModel(d)
        val description = d.description.ifEmpty { null }

        return when (kind) {
            WorkKind.REPO_TASK -> {
                val body = buildJsonObject {
                    put("type", "repo-task")
                    put("title", name)
                    put("prompt", prompt)
                    description?.let { put("description", it) }
                    put("agentType", d.runtime)
                    put("maxRetries", d.maxRetries)
                    put("priority", d.priority)
                    put("repoUrl", repoUrl)
                    put("repoBranch", d.repoBranch)
                    options?.let { put("metadata", jsonObjectOf("agentOptions" to it)) }
                    if (d.dependsOn.isNotEmpty()) put("dependsOn", JsonArray(d.dependsOn.map(::JsonPrimitive)))
                    putAll(location)
                }
                val id = api.createTaskUnified(body)
                Created(kind, TaskDetailRoute(id), "$name started — it will open a PR")
            }

            WorkKind.REPO_BLUEPRINT -> {
                val id = withTrigger(
                    trigger,
                    create = {
                        api.createTaskUnified(
                            buildJsonObject {
                                put("type", "repo-blueprint")
                                put("title", runName ?: name)
                                put("name", name)
                                put("prompt", prompt)
                                description?.let { put("description", it) }
                                put("agentType", d.runtime)
                                putOrNull("agentOptions", options)
                                put("maxRetries", d.maxRetries)
                                put("priority", d.priority)
                                put("repoUrl", repoUrl)
                                put("repoBranch", d.repoBranch)
                                put("enabled", true)
                                putAll(location)
                            },
                        )
                    },
                    attach = { id, t -> api.createTaskTrigger(id, t.body) },
                    discard = { id -> api.deleteTaskConfig(id) },
                )
                Created(kind, ScheduledDetailRoute(id), "$name saved")
            }

            WorkKind.STANDALONE -> {
                val id = withTrigger(
                    trigger,
                    create = {
                        api.createTaskUnified(
                            buildJsonObject {
                                put("type", "standalone")
                                put("title", name)
                                put("name", name)
                                runName?.let { put("runTitle", it) }
                                put("prompt", prompt)
                                description?.let { put("description", it) }
                                put("agentType", d.runtime)
                                model?.let { put("model", it) }
                                putOrNull("agentOptions", options)
                                put("maxRetries", d.maxRetries)
                                put("enabled", true)
                                putAll(location)
                            },
                        )
                    },
                    attach = { id, t -> api.createTaskTrigger(id, t.body) },
                    discard = { id -> api.deleteWorkflow(id) },
                )
                if (trigger != null) return Created(kind, JobDetailRoute(id), "$name saved")
                val runId = try {
                    api.createTaskRun(id)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    throw AfterCreate(e)
                }
                Created(kind, JobRunRoute(id, runId), "$name started")
            }

            WorkKind.LOCAL_BLUEPRINT -> {
                val id = withTrigger(
                    trigger,
                    create = {
                        api.createLocalBlueprint(
                            buildJsonObject {
                                put("name", name)
                                description?.let { put("description", it) }
                                put("hostId", d.location.localHostId)
                                put("dir", d.location.localDir)
                                if (d.withRepo && repoUrl.isNotEmpty()) put("repoUrl", repoUrl)
                                // "New branch": the spawn wraps the prompt with branch + PR
                                // instructions off this base.
                                if (d.withRepo) put("baseBranch", d.repoBranch.ifEmpty { "main" })
                                put("commandTemplate", prompt)
                                runName?.let { put("runTitle", it) }
                                if (d.runtime == TERMINAL) put("agent", JsonNull) else put("agent", d.runtime)
                                put("spawnMode", "auto")
                                put("sessionMode", sessionModeFor(d))
                            },
                        )
                    },
                    attach = { id, t -> api.createLocalBlueprintTrigger(id, t.body) },
                    discard = { id -> api.deleteLocalBlueprint(id) },
                )
                Created(kind, LocalAutomationRoute(id), "$name saved")
            }

            WorkKind.LOCAL_TERMINAL -> {
                val spec = if (d.runtime == TERMINAL) {
                    jsonObjectOf("kind" to JsonPrimitive("shell"))
                } else {
                    buildJsonObject {
                        put("kind", "agent")
                        put("agent", d.runtime)
                        if (prompt.isNotEmpty()) put("prompt", prompt)
                        model?.let { put("model", it) }
                        // "New branch": the server wraps the prompt with branch + PR
                        // instructions off this base.
                        if (d.withRepo) put("baseBranch", d.repoBranch.ifEmpty { "main" })
                    }
                }
                val id = api.createLocalTerminal(
                    buildJsonObject {
                        put("hostId", d.location.localHostId)
                        put("dir", d.location.localDir)
                        put("title", name)
                        put("spec", spec)
                    },
                )
                Created(kind, LocalTerminalRoute(id), "$name opened")
            }

            WorkKind.POD_SESSION -> {
                // A pod session is a terminal plus a Claude Code chat in a repo pod; the runtime
                // is fixed and the first message is typed in the session, so only the repo and
                // the name travel.
                val id = api.createPodSession(
                    buildJsonObject {
                        put("repoUrl", repoUrl)
                        put("title", name)
                    },
                )
                Created(kind, SessionDetailRoute(id), "$name opened")
            }

            WorkKind.PERSISTENT_AGENT -> {
                val id = withTrigger(
                    trigger,
                    create = {
                        api.createPersistentAgent(
                            buildJsonObject {
                                put("slug", d.agent.slug.trim().ifEmpty { slugify(name) })
                                put("name", name)
                                description?.let { put("description", it) }
                                put("agentRuntime", d.runtime)
                                putOrNull("model", model)
                                putOrNull("agentOptions", options)
                                putOrNull("systemPrompt", d.agent.systemPrompt.ifEmpty { null })
                                put("agentsMd", d.agent.agentsMd.ifEmpty { DEFAULT_AGENTS_MD })
                                put("initialPrompt", prompt)
                                put("podLifecycle", d.agent.podLifecycle.raw)
                            },
                        )
                    },
                    attach = { id, t -> api.createPersistentAgentTrigger(id, t.body) },
                    discard = { id -> api.deletePersistentAgent(id) },
                )
                Created(kind, AgentDetailRoute(id), "$name created")
            }
        }
    }

    // region Editing

    /**
     * Saves an edited draft back onto its row. The kind is fixed (the form refuses answers that
     * would change it), so this is the PATCH half of [createOnce]'s branch for that kind plus a
     * trigger sync. Returns where to go next.
     */
    suspend fun update(target: EditTarget, d: WorkDraft, repoUrl: String): Created {
        val id = target.id
        val name = d.name.trim().ifEmpty { target.row["name"]?.stringValue ?: target.row["title"]?.stringValue.orEmpty() }
        val runName = runNameFor(d)
        val prompt = d.prompt.trim()
        val trigger = triggerFor(d)
        val location = locationPayload(d)
        val options = setOptions(d)
        val model = pickedModel(d)
        val route = target.detailRoute

        when (target.kind) {
            EditableKind.REPO_BLUEPRINT -> {
                api.updateTaskConfig(
                    id,
                    buildJsonObject {
                        put("name", name)
                        put("title", runName ?: name)
                        put("prompt", prompt)
                        putOrNull("description", d.description.ifEmpty { null })
                        put("agentType", d.runtime)
                        putOrNull("agentOptions", options)
                        put("maxRetries", d.maxRetries)
                        put("priority", d.priority)
                        put("repoUrl", repoUrl)
                        put("repoBranch", d.repoBranch)
                        putAll(location)
                    },
                )
                syncTrigger(target, trigger, taskTriggerOps(id))
            }

            EditableKind.STANDALONE -> {
                api.updateWorkflow(
                    id,
                    buildJsonObject {
                        put("name", name)
                        putOrNull("runTitle", runName)
                        put("promptTemplate", prompt)
                        // The Job PATCH takes a string here (blank clears it), not null.
                        put("description", d.description)
                        put("agentRuntime", d.runtime)
                        putOrNull("model", model)
                        putOrNull("agentOptions", options)
                        put("maxRetries", d.maxRetries)
                        putAll(location)
                    },
                )
                syncTrigger(target, trigger, taskTriggerOps(id))
            }

            EditableKind.LOCAL_BLUEPRINT -> {
                api.updateLocalBlueprint(
                    id,
                    buildJsonObject {
                        put("name", name)
                        putOrNull("description", d.description.ifEmpty { null })
                        putOrNull("hostId", d.location.localHostId.ifEmpty { null })
                        putOrNull("dir", d.location.localDir.ifEmpty { null })
                        putOrNull("repoUrl", repoUrl.takeIf { d.withRepo && it.isNotEmpty() })
                        putOrNull("baseBranch", if (d.withRepo) d.repoBranch.ifEmpty { "main" } else null)
                        put("commandTemplate", prompt)
                        putOrNull("runTitle", runName)
                        putOrNull("agent", d.runtime.takeUnless { it == TERMINAL })
                        put("sessionMode", sessionModeFor(d))
                    },
                )
                syncTrigger(
                    target,
                    trigger,
                    TriggerOps(
                        create = { api.createLocalBlueprintTrigger(id, it.body) },
                        update = { tid, config -> api.updateLocalBlueprintTrigger(id, tid, jsonObjectOf("config" to config)) },
                        remove = { tid -> api.deleteLocalBlueprintTrigger(id, tid) },
                    ),
                )
            }
        }
        return Created(target.kind.kind, route, "$name saved")
    }

    private fun taskTriggerOps(id: String) = TriggerOps(
        create = { api.createTaskTrigger(id, it.body) },
        update = { tid, config -> api.updateTaskTrigger(id, tid, jsonObjectOf("config" to config)) },
        remove = { tid -> api.deleteTaskTrigger(id, tid) },
    )

    // endregion
}

private fun sessionModeFor(d: WorkDraft): String =
    if (d.then == Then.WAITS_FOR_ME) LocalSessionMode.INTERACTIVE.raw else LocalSessionMode.HEADLESS.raw

/** How to create, patch and delete a trigger on one row. */
class TriggerOps(
    val create: suspend (TriggerSpec) -> Unit,
    val update: suspend (triggerId: String, config: JsonObject) -> Unit,
    val remove: suspend (triggerId: String) -> Unit,
)

/**
 * Brings the one trigger the form edits in line with the draft. Same type: patch its config in
 * place (a webhook keeps its path, a schedule its id). Different type: create the new one first,
 * then retire the old, so a rejected config never leaves the row with no trigger. Triggers the
 * form didn't load (a second one added elsewhere) are left alone.
 */
suspend fun syncTrigger(target: EditTarget, wanted: TriggerSpec?, ops: TriggerOps) {
    val current = target.trigger
    val currentId = current?.get("id")?.stringValue
    if (wanted == null) {
        if (currentId != null) ops.remove(currentId)
        return
    }
    if (current != null && currentId != null && current["type"]?.stringValue == wanted.type) {
        ops.update(currentId, wanted.config)
        return
    }
    ops.create(wanted)
    if (currentId != null) ops.remove(currentId)
}
