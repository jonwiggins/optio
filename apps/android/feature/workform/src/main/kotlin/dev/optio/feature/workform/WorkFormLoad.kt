package dev.optio.feature.workform

import androidx.navigation3.runtime.NavKey
import dev.optio.core.model.boolValue
import dev.optio.core.model.intValue
import dev.optio.core.model.stringValue
import dev.optio.core.navigation.routes.JobDetailRoute
import dev.optio.core.navigation.routes.LocalAutomationRoute
import dev.optio.core.navigation.routes.ScheduledDetailRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Port of `apps/web/src/components/work-form/load.ts`: a saved recurring definition reopened in the
// same form (iOS has no edit mode; the web does, per CLAUDE.md "Recurring work is edited in the
// same form").

/** The kinds that persist a definition, and so can be edited: a scheduled Task, a Job, a Local automation. */
enum class EditableKind(val kind: WorkKind) {
    REPO_BLUEPRINT(WorkKind.REPO_BLUEPRINT),
    STANDALONE(WorkKind.STANDALONE),
    LOCAL_BLUEPRINT(WorkKind.LOCAL_BLUEPRINT),
    ;

    companion object {
        fun fromRaw(raw: String?): EditableKind? = entries.firstOrNull { it.kind.raw == raw }
    }
}

/**
 * Saved work opened for editing: the kind its row lives in (fixed for the edit), the row itself,
 * the trigger the form edits (the first enabled one), every trigger on the row, and the draft the
 * row is the point for.
 */
data class EditTarget(
    val id: String,
    val kind: EditableKind,
    val row: JsonObject,
    val trigger: JsonObject?,
    val triggers: List<JsonObject>,
    val draft: WorkDraft,
) {
    /** The page about the row: its stats, triggers and prior runs (web `detailHref`). */
    val detailRoute: NavKey
        get() = when (kind) {
            EditableKind.REPO_BLUEPRINT -> ScheduledDetailRoute(id)
            EditableKind.STANDALONE -> JobDetailRoute(id)
            EditableKind.LOCAL_BLUEPRINT -> LocalAutomationRoute(id)
        }

    /** The saved name (the Name field's placeholder). */
    val savedName: String
        get() = row.text("name").ifEmpty { row.text("title") }
}

/** The When answer a stored trigger row stands for. */
data class WhenAnswer(
    val whenType: WhenType,
    val trigger: TriggerConfig,
    val event: EventTrigger,
)

/** A stored trigger row, back to the form's When answer. */
fun whenFromTrigger(trigger: JsonObject?): WhenAnswer {
    val base = WhenAnswer(WhenType.MANUAL, TriggerConfig.MANUAL, WorkDraft.EMPTY.event)
    if (trigger == null) return base
    val c = trigger["config"] as? JsonObject ?: JsonObject(emptyMap())
    val type = trigger.text("type")
    EventTriggerType.fromRaw(type)?.let { event ->
        return WhenAnswer(WhenType.fromRaw(type)!!, TriggerConfig.MANUAL, EventTrigger(event, c))
    }
    return when (type) {
        "schedule" -> base.copy(
            whenType = WhenType.SCHEDULE,
            trigger = TriggerConfig(type = TriggerType.SCHEDULE, cronExpression = c.text("cronExpression")),
        )
        "webhook" -> base.copy(
            whenType = WhenType.WEBHOOK,
            trigger = TriggerConfig(type = TriggerType.WEBHOOK, webhookPath = c.text("path")),
        )
        "ticket" -> base.copy(
            whenType = WhenType.TICKET,
            trigger = TriggerConfig(
                type = TriggerType.TICKET,
                ticketSource = TicketSource.fromRaw(c.text("source")) ?: TicketSource.GITHUB,
                ticketLabels = (c["labels"] as? JsonArray)?.let { c.strings("labels") } ?: emptyList(),
            ),
        )
        else -> base
    }
}

/** A persisted row's run location (`runLocationFromRow`). */
fun runLocationFromRow(row: JsonObject): RunLocation {
    if (row.text("runTarget") != "local") return RunLocation.CLUSTER
    return RunLocation(
        runTarget = Where.LOCAL,
        localHostId = row.text("localHostId"),
        localDir = row.text("localDir"),
        localSessionMode = if (row.text("localSessionMode") == "interactive") LocalSessionMode.INTERACTIVE else LocalSessionMode.HEADLESS,
    )
}

/** The row's saved agent parameters, folding a legacy single `model` in. */
private fun optionsFromRow(runtime: String, row: JsonObject): Map<String, OptionValue> {
    val out = LinkedHashMap<String, OptionValue>()
    (row["agentOptions"] as? JsonObject)?.forEach { (k, v) -> OptionValue.fromJson(v)?.let { out[k] = it } }
    if (runtime != TERMINAL) {
        val field = modelFieldForRuntime(runtime)
        val model = row["model"]?.stringValue
        if (!model.isNullOrEmpty() && out[field] == null) out[field] = OptionValue.Str(model)
    }
    return out
}

/**
 * The draft a saved row is the point for: the inverse of `createWork`'s branch for its kind.
 * [normalize] then confirms the draft sits inside the space, which it does for anything the form
 * itself saved.
 */
fun draftFromRow(kind: EditableKind, row: JsonObject, trigger: JsonObject?): WorkDraft {
    val w = whenFromTrigger(trigger)
    val common = WorkDraft.EMPTY.copy(
        whenType = w.whenType,
        trigger = w.trigger,
        event = w.event,
        name = row.text("name").ifEmpty { row.text("title") },
        description = row.text("description"),
    )
    return when (kind) {
        EditableKind.REPO_BLUEPRINT -> {
            val runtime = row.text("agentType").ifEmpty { "claude-code" }
            val title = row.text("title")
            normalize(
                common.copy(
                    // The form saves `title = name` when no run name is set.
                    runName = if (title.isNotEmpty() && title != row.text("name")) title else "",
                    location = runLocationFromRow(row),
                    withRepo = true,
                    repoUrl = row.text("repoUrl"),
                    repoBranch = row.text("repoBranch").ifEmpty { "main" },
                    runtime = runtime,
                    agentOptions = optionsFromRow(runtime, row),
                    prompt = row.text("prompt"),
                    then = Then.EXITS,
                    priority = row["priority"]?.intValue ?: WorkDraft.EMPTY.priority,
                    maxRetries = row["maxRetries"]?.intValue ?: WorkDraft.EMPTY.maxRetries,
                ),
            )
        }
        EditableKind.STANDALONE -> {
            val runtime = row.text("agentRuntime").ifEmpty { "claude-code" }
            normalize(
                common.copy(
                    runName = row.text("runTitle"),
                    location = runLocationFromRow(row),
                    withRepo = false,
                    runtime = runtime,
                    agentOptions = optionsFromRow(runtime, row),
                    prompt = row.text("promptTemplate"),
                    then = Then.EXITS,
                    maxRetries = row["maxRetries"]?.intValue ?: WorkDraft.EMPTY.maxRetries,
                ),
            )
        }
        EditableKind.LOCAL_BLUEPRINT -> {
            val interactive = row.text("sessionMode") != "headless"
            val baseBranch = row.text("baseBranch")
            normalize(
                common.copy(
                    runName = row.text("runTitle"),
                    location = RunLocation(
                        runTarget = Where.LOCAL,
                        localHostId = row.text("hostId"),
                        localDir = row.text("dir"),
                        localSessionMode = if (interactive) LocalSessionMode.INTERACTIVE else LocalSessionMode.HEADLESS,
                    ),
                    withRepo = baseBranch.isNotEmpty(),
                    repoUrl = row.text("repoUrl"),
                    repoBranch = baseBranch.ifEmpty { "main" },
                    runtime = row.text("agent").ifEmpty { TERMINAL },
                    agentOptions = emptyMap(),
                    prompt = row.text("commandTemplate"),
                    then = if (interactive) Then.WAITS_FOR_ME else Then.EXITS,
                ),
            )
        }
    }
}

/** The trigger the form should show: the first enabled one, else the first. */
fun pickTrigger(triggers: List<JsonObject>): JsonObject? =
    triggers.firstOrNull { it["enabled"]?.boolValue != false } ?: triggers.firstOrNull()

/** Why an id can't open in the form. */
class NotEditableException(message: String) : Exception(message)

/**
 * Resolves an id to something the form can edit. The unified `/api/tasks` resolver covers
 * scheduled Tasks and Jobs; Local automations live under `/api/local/blueprints`. Anything else (a
 * one-shot Task, a run, a terminal, an agent) is not a definition and has no edit form.
 */
suspend fun loadEditTarget(api: ApiClient, id: String): EditTarget {
    val unified = try {
        api.getTaskUnified(id)
    } catch (e: ApiError) {
        if (e.status == ApiError.NOT_FOUND) null else throw e
    }
    if (unified != null) {
        val kind = EditableKind.fromRaw(unified.text("type"))
            ?: throw NotEditableException("Only recurring work — a scheduled Task, a Job or a Local automation — opens in the form. Edit this one from its own page.")
        val triggers = api.listTaskTriggers(id)
        val trigger = pickTrigger(triggers)
        return EditTarget(id, kind, unified, trigger, triggers, draftFromRow(kind, unified, trigger))
    }
    return try {
        coroutineScope {
            val blueprint = async { api.getLocalBlueprint(id) }
            val triggers = async { api.listLocalBlueprintTriggers(id) }
            val list = triggers.await()
            val trigger = pickTrigger(list)
            val row = blueprint.await()
            EditTarget(id, EditableKind.LOCAL_BLUEPRINT, row, trigger, list, draftFromRow(EditableKind.LOCAL_BLUEPRINT, row, trigger))
        }
    } catch (e: ApiError) {
        if (e.status == ApiError.NOT_FOUND) {
            throw NotEditableException("There's no recurring work with this id on this server — it may have been deleted.")
        }
        throw e
    }
}

/** The value at [key] as text: a string, or a number's digits; "" for null / missing (`String(x ?? "")`). */
internal fun JsonObject.text(key: String): String {
    val p = this[key] as? JsonPrimitive ?: return ""
    if (p is kotlinx.serialization.json.JsonNull) return ""
    return p.content
}
