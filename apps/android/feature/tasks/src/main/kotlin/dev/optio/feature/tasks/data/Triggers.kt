package dev.optio.feature.tasks.data

import dev.optio.core.model.arrayValue
import dev.optio.core.model.boolValue
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import java.time.Instant
import java.util.Locale
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Triggers: one row shape and one editor for every target this module shows (Jobs and scheduled
// Tasks), the same fourteen types the server takes (apps/api/src/schemas/trigger.ts,
// packages/shared/src/types/triggers.ts). iOS: `TriggerRow` / `JobTrigger` (RunModels.swift,
// JobsAPI.swift), `ScheduleFormat.swift`, the trigger editors of `JobFormView` and
// `TriggerFormSheet`.

/** The trigger types, with the copy the app shows for each. */
enum class TriggerKind(val raw: String, val label: String) {
    MANUAL("manual", "Manual"),
    SCHEDULE("schedule", "Schedule"),
    WEBHOOK("webhook", "Webhook"),
    TICKET("ticket", "Ticket"),
    GITHUB("github", "GitHub"),
    GITLAB("gitlab", "GitLab"),
    SLACK("slack", "Slack"),
    LINEAR("linear", "Linear"),
    JIRA("jira", "Jira"),
    PYLON("pylon", "Pylon"),
    PAGERDUTY("pagerduty", "PagerDuty"),
    SENTRY("sentry", "Sentry"),
    ALERTMANAGER("alertmanager", "Alertmanager"),
    DATADOG("datadog", "Datadog"),
    UNKNOWN("", "Trigger"),
    ;

    /**
     * Pylon, Alertmanager and Datadog can't sign their deliveries, so each of their triggers has
     * its own shared secret (minted on create, shown once) and its own URL,
     * `/api/hooks/<type>/<trigger id>` (`SELF_SECRET_TRIGGER_TYPES` in `@optio/shared`).
     */
    val selfSecret: Boolean
        get() = this == PYLON || this == ALERTMANAGER || this == DATADOG

    companion object {
        /** The types a Job or a scheduled Task takes, in picker order. */
        val editable: List<TriggerKind> = listOf(MANUAL, SCHEDULE, WEBHOOK, TICKET, GITHUB, GITLAB, SLACK, LINEAR, JIRA, PYLON, PAGERDUTY, SENTRY, ALERTMANAGER, DATADOG)

        fun fromRaw(raw: String?): TriggerKind = entries.firstOrNull { it.raw == raw && it != UNKNOWN } ?: UNKNOWN
    }
}

/** A `workflow_triggers` row, as `/api/jobs/:id/triggers` and `/api/task-configs/:id/triggers` return it. */
@Serializable
data class TriggerRow(
    val id: String,
    val targetType: String? = null,
    val targetId: String? = null,
    val workflowId: String? = null,
    val type: String = "manual",
    val config: Map<String, JsonElement>? = null,
    val paramMapping: Map<String, JsonElement>? = null,
    val enabled: Boolean = true,
    @Serializable(with = LenientInstantSerializer::class) val lastFiredAt: Instant? = null,
    @Serializable(with = LenientInstantSerializer::class) val nextFireAt: Instant? = null,
    @Serializable(with = LenientInstantSerializer::class) val createdAt: Instant? = null,
) {
    val kind: TriggerKind
        get() = TriggerKind.fromRaw(type)

    /** The type as the app names it ("Schedule", "GitHub"); unknown types as sent. */
    val label: String
        get() = if (kind == TriggerKind.UNKNOWN) type.replaceFirstChar { it.titlecase(Locale.US) } else kind.label

    val cronExpression: String?
        get() = config.string("cronExpression")

    val webhookPath: String?
        get() = config.string("path")

    val webhookSecret: String?
        get() = config.string("secret")

    val ticketSource: String?
        get() = config.string("source")

    val ticketLabels: List<String>
        get() = config.strings("labels")

    /** The webhook's public URL on [baseUrl] (`…/api/hooks/<path>`), for webhook triggers. */
    fun webhookUrl(baseUrl: String?): String? = webhookPath?.let { TriggerText.hookUrl(baseUrl, it) }

    /** Whether a shared secret is set (`hasSecret`, the read-side marker; the secret itself is never returned). */
    val hasSecret: Boolean
        get() = config?.get("hasSecret")?.boolValue == true || !webhookSecret.isNullOrEmpty()

    /**
     * The URL a self-secret trigger (Pylon, Alertmanager, Datadog) listens on,
     * `…/api/hooks/<type>/<id>`; null for the other types.
     */
    fun selfSecretUrl(baseUrl: String?): String? = if (kind.selfSecret) TriggerText.hookUrl(baseUrl, "${kind.raw}/$id") else null

    /** One line about what fires it (see [TriggerText.summary]). */
    val summary: String
        get() = TriggerText.summary(kind, config.orEmpty())
}

/** Which resource a trigger hangs off: the URL prefix of its routes. */
enum class TriggerOwner(val prefix: String) {
    JOB("/api/jobs"),
    TASK_CONFIG("/api/task-configs"),
}

@Serializable internal data class TriggersEnvelope(val triggers: List<TriggerRow> = emptyList())

@Serializable internal data class TriggerEnvelope(val trigger: TriggerRow)

suspend fun ApiClient.listTriggers(owner: TriggerOwner, id: String): List<TriggerRow> =
    get<TriggersEnvelope>("${owner.prefix}/$id/triggers").triggers

/** `POST …/:id/triggers` with `{ type, config, enabled }`. */
suspend fun ApiClient.createTrigger(owner: TriggerOwner, id: String, type: String, config: JsonObject, enabled: Boolean): TriggerRow =
    post<TriggerEnvelope>(
        "${owner.prefix}/$id/triggers",
        mapOf("type" to type, "config" to config, "enabled" to enabled),
    ).trigger

/** `PATCH …/:id/triggers/:triggerId`: [config] replaces the stored config; a type can't change. */
suspend fun ApiClient.updateTrigger(owner: TriggerOwner, id: String, triggerId: String, config: JsonObject? = null, enabled: Boolean? = null): TriggerRow =
    patch<TriggerEnvelope>(
        "${owner.prefix}/$id/triggers/$triggerId",
        buildMap<String, Any?> {
            if (config != null) put("config", config)
            if (enabled != null) put("enabled", enabled)
        },
    ).trigger

suspend fun ApiClient.deleteTrigger(owner: TriggerOwner, id: String, triggerId: String) =
    delete("${owner.prefix}/$id/triggers/$triggerId")

/** One option of an event-kind checklist (iOS `WorkForm.EventKind`). */
data class EventKindOption(val value: String, val label: String, val personal: Boolean)

/** Trigger copy and the constants the editors use (web `trigger-selector.tsx`, iOS `WorkForm`). */
object TriggerText {
    data class CronPreset(val label: String, val expr: String)

    val cronPresets: List<CronPreset> = listOf(
        CronPreset("Every hour", "0 * * * *"),
        CronPreset("Every 6h", "0 */6 * * *"),
        CronPreset("Daily 09:00 UTC", "0 9 * * *"),
        CronPreset("Weekdays 09:00 UTC", "0 9 * * 1-5"),
        CronPreset("Mon 09:00 UTC", "0 9 * * 1"),
    )

    val ticketSources: List<String> = listOf("github", "gitlab", "linear", "jira", "notion")

    val githubKinds: List<EventKindOption> = listOf(
        EventKindOption("review_requested", "Review requested from me", personal = true),
        EventKindOption("mentioned", "I'm @-mentioned", personal = true),
        EventKindOption("assigned", "Assigned to me", personal = true),
        EventKindOption("pr_opened", "Any PR opened", personal = false),
        EventKindOption("issue_opened", "Any issue opened", personal = false),
        EventKindOption("pr_merged", "A PR is merged", personal = false),
        EventKindOption("labeled", "A label is added", personal = false),
        EventKindOption("push", "A branch is pushed", personal = false),
        EventKindOption("release_published", "A release is published", personal = false),
        EventKindOption("workflow_succeeded", "A workflow run passes", personal = false),
        EventKindOption("workflow_failed", "A workflow run fails", personal = false),
    )

    /** GitHub's kinds in GitLab's words (`GITLAB_EVENT_KINDS`): merge requests, issues, notes, pushes, releases, pipelines. */
    val gitlabKinds: List<EventKindOption> = listOf(
        EventKindOption("review_requested", "Review requested from me", personal = true),
        EventKindOption("mentioned", "I'm @-mentioned", personal = true),
        EventKindOption("assigned", "Assigned to me", personal = true),
        EventKindOption("mr_opened", "Any MR opened", personal = false),
        EventKindOption("mr_merged", "An MR is merged", personal = false),
        EventKindOption("issue_opened", "Any issue opened", personal = false),
        EventKindOption("labeled", "A label is added", personal = false),
        EventKindOption("push", "A branch is pushed", personal = false),
        EventKindOption("release_published", "A release is published", personal = false),
        EventKindOption("pipeline_succeeded", "A pipeline passes", personal = false),
        EventKindOption("pipeline_failed", "A pipeline fails", personal = false),
    )

    val linearKinds: List<EventKindOption> = listOf(
        EventKindOption("assigned", "Assigned to me", personal = true),
        EventKindOption("mentioned", "I'm @-mentioned", personal = true),
        EventKindOption("created", "Any issue created", personal = false),
        EventKindOption("labeled", "A label is added", personal = false),
    )

    /** Jira Cloud issue / comment events (`JIRA_EVENT_KINDS`). */
    val jiraKinds: List<EventKindOption> = listOf(
        EventKindOption("assigned", "Assigned to me", personal = true),
        EventKindOption("mentioned", "I'm mentioned", personal = true),
        EventKindOption("created", "Any issue created", personal = false),
        EventKindOption("commented", "A comment is added", personal = false),
        EventKindOption("transitioned", "Status changes", personal = false),
        EventKindOption("labeled", "A label is added", personal = false),
    )

    /** Sentry internal-integration webhooks (`SENTRY_EVENT_KINDS`); none is about you. */
    val sentryKinds: List<EventKindOption> = listOf(
        EventKindOption("issue_created", "New issue", personal = false),
        EventKindOption("issue_unresolved", "Issue regressed", personal = false),
        EventKindOption("issue_resolved", "Issue resolved", personal = false),
        EventKindOption("issue_assigned", "Issue assigned", personal = false),
        EventKindOption("issue_archived", "Issue archived", personal = false),
        EventKindOption("alert_triggered", "Issue alert fires", personal = false),
        EventKindOption("metric_alert_critical", "Metric alert critical", personal = false),
        EventKindOption("metric_alert_warning", "Metric alert warning", personal = false),
        EventKindOption("metric_alert_resolved", "Metric alert resolved", personal = false),
    )

    /** Alertmanager / Grafana alert groups (`ALERTMANAGER_EVENT_KINDS`): the group's status. */
    val alertmanagerKinds: List<EventKindOption> = listOf(
        EventKindOption("firing", "Alerts firing", personal = false),
        EventKindOption("resolved", "Alerts resolved", personal = false),
    )

    /** Datadog monitor transitions (`DATADOG_EVENT_KINDS`). */
    val datadogKinds: List<EventKindOption> = listOf(
        EventKindOption("triggered", "Monitor triggered", personal = false),
        EventKindOption("warning", "Monitor warning", personal = false),
        EventKindOption("no_data", "No data", personal = false),
        EventKindOption("recovered", "Monitor recovered", personal = false),
    )

    /** The header a self-secret delivery (Pylon, Alertmanager, Datadog) carries its trigger's secret in. */
    const val SECRET_HEADER = "X-Optio-Secret"

    /** Where to set the trigger up, per self-secret type (one line of copy under its fields). */
    fun selfSecretHint(kind: TriggerKind): String? = when (kind) {
        TriggerKind.PYLON -> "In Pylon → Settings → Triggers, add a webhook to this trigger's URL with the header $SECRET_HEADER. The id and the secret are made when the trigger is saved and shown once right after."
        TriggerKind.ALERTMANAGER -> "Point an Alertmanager webhook_config (authorization: credentials = the secret, or basic auth with any user and the secret as password) or a Grafana Webhook contact point (Authorization header \"Bearer <secret>\") at this trigger's URL. The id and the secret are made when the trigger is saved and shown once right after."
        TriggerKind.DATADOG -> "In Datadog → Integrations → Webhooks, add a webhook with this trigger's URL, a custom header $SECRET_HEADER: <secret>, and Optio's payload template, then @webhook-<name> in the monitor's message. The id and the secret are made when the trigger is saved and shown once right after."
        else -> null
    }

    /** PagerDuty Webhooks v3 incident events (`PAGERDUTY_EVENT_KINDS`); none is about you. Pylon's kinds are free text. */
    val pagerdutyKinds: List<EventKindOption> = listOf(
        EventKindOption("incident.triggered", "Incident triggered", personal = false),
        EventKindOption("incident.acknowledged", "Incident acknowledged", personal = false),
        EventKindOption("incident.unacknowledged", "Incident unacknowledged", personal = false),
        EventKindOption("incident.resolved", "Incident resolved", personal = false),
        EventKindOption("incident.escalated", "Incident escalated", personal = false),
        EventKindOption("incident.reassigned", "Incident reassigned", personal = false),
        EventKindOption("incident.delegated", "Incident delegated", personal = false),
        EventKindOption("incident.reopened", "Incident reopened", personal = false),
        EventKindOption("incident.priority_updated", "Priority updated", personal = false),
        EventKindOption("incident.responder.added", "Responder added", personal = false),
        EventKindOption("incident.responder.replied", "Responder replied", personal = false),
        EventKindOption("incident.status_update_published", "Status update published", personal = false),
        EventKindOption("incident.annotated", "Incident annotated", personal = false),
    )

    /** The server's Slack channel id rule (`C0123ABCD`). */
    val slackChannelId = Regex("^[A-Z][A-Z0-9]{5,}$")

    /** Five space-separated fields. */
    fun cronIsValid(expr: String?): Boolean = expr?.trim()?.split(Regex("\\s+"))?.filter { it.isNotEmpty() }?.size == 5

    /** The presets in words (iOS `WorkForm.cronWords`). */
    private val cronWords: Map<String, String> = mapOf(
        "0 * * * *" to "every hour",
        "0 */6 * * *" to "every 6 hours",
        "0 9 * * *" to "daily at 09:00 UTC",
        "0 9 * * 1-5" to "weekdays at 09:00 UTC",
        "0 9 * * 1" to "Mondays at 09:00 UTC",
    )

    /** The footer under a cron field (iOS `WhenSection` footer, web `TriggerSelector` hint). */
    fun cronHint(expr: String?): String = when {
        !cronIsValid(expr) -> "Expected five space-separated fields."
        else -> cronWords[expr!!.trim()]?.let { "Runs $it." } ?: "Five-field cron expression, in UTC."
    }

    /** `<server>/api/hooks/<path>`. */
    fun hookUrl(baseUrl: String?, path: String): String = "${baseUrl.orEmpty().trimEnd('/')}/api/hooks/$path"

    /** A fresh webhook path (`hook-1a2b3c4d`). */
    fun newWebhookPath(): String = "hook-" + UUID.randomUUID().toString().replace("-", "").take(8)

    /** Keeps what a webhook path may hold: letters, digits, `-` and `_`. */
    fun sanitizePath(text: String): String = text.filter { it.isLetterOrDigit() || it == '-' || it == '_' }

    fun sourceLabel(source: String): String = when (source) {
        "github" -> "GitHub"
        "gitlab" -> "GitLab"
        "pagerduty" -> "PagerDuty"
        else -> source.replaceFirstChar { it.titlecase(Locale.US) }
    }

    /** The kinds a trigger type offers; empty for Slack and Pylon (free text) and the plain types. */
    fun kinds(kind: TriggerKind): List<EventKindOption> = when (kind) {
        TriggerKind.GITHUB -> githubKinds
        TriggerKind.GITLAB -> gitlabKinds
        TriggerKind.LINEAR -> linearKinds
        TriggerKind.JIRA -> jiraKinds
        TriggerKind.PAGERDUTY -> pagerdutyKinds
        TriggerKind.SENTRY -> sentryKinds
        TriggerKind.ALERTMANAGER -> alertmanagerKinds
        TriggerKind.DATADOG -> datadogKinds
        else -> emptyList()
    }

    /** One line about what fires a trigger of [kind] with [config]. */
    fun summary(kind: TriggerKind, config: Map<String, JsonElement>): String {
        fun str(key: String) = config[key]?.stringValue?.takeIf { it.isNotBlank() }
        fun list(key: String) = config[key]?.arrayValue?.mapNotNull { it.stringValue }.orEmpty()
        fun kindsLine(any: String) = list("events").map { e -> kinds(kind).firstOrNull { it.value == e }?.label ?: e }.takeIf { it.isNotEmpty() }?.joinToString(", ") ?: any
        return when (kind) {
            TriggerKind.MANUAL -> "Runs when started by hand"
            TriggerKind.SCHEDULE -> str("cronExpression")?.let { cron -> ScheduleFormat.cron(cron).let { if (it == cron) cron else "$it · $cron" } } ?: "No schedule"
            TriggerKind.WEBHOOK -> str("path")?.let { "/api/hooks/$it" } ?: "No path"
            TriggerKind.TICKET -> {
                val source = sourceLabel(str("source") ?: "github")
                val labels = list("labels")
                if (labels.isEmpty()) "$source tickets" else "$source tickets · ${labels.joinToString(", ")}"
            }
            TriggerKind.GITHUB -> listOfNotNull(
                kindsLine("Any GitHub event"),
                str("login")?.let { "@$it" },
                list("repos").takeIf { it.isNotEmpty() }?.joinToString(", "),
                list("branches").takeIf { it.isNotEmpty() }?.joinToString(", "),
                list("workflows").takeIf { it.isNotEmpty() }?.joinToString(", "),
                list("labels").takeIf { it.isNotEmpty() }?.joinToString(", "),
            ).joinToString(" · ")
            TriggerKind.GITLAB -> listOfNotNull(
                kindsLine("Any GitLab event"),
                str("username")?.let { "@$it" },
                list("projects").takeIf { it.isNotEmpty() }?.joinToString(", "),
                list("branches").takeIf { it.isNotEmpty() }?.joinToString(", "),
                list("labels").takeIf { it.isNotEmpty() }?.joinToString(", "),
            ).joinToString(" · ")
            TriggerKind.SLACK -> listOfNotNull(
                str("channelId")?.let { "#$it" } ?: "No channel",
                if (config["mentionOnly"]?.boolValue == true) "@-mentions only" else null,
                str("keyword")?.let { "“$it”" },
                if (config["includeThreads"]?.boolValue == true) "with threads" else null,
            ).joinToString(" · ")
            TriggerKind.LINEAR -> listOfNotNull(
                kindsLine("Any Linear event"),
                str("user"),
                list("labels").takeIf { it.isNotEmpty() }?.joinToString(", "),
                list("teams").takeIf { it.isNotEmpty() }?.joinToString(", "),
            ).joinToString(" · ")
            TriggerKind.JIRA -> listOfNotNull(
                kindsLine("Any Jira event"),
                str("user"),
                list("projects").takeIf { it.isNotEmpty() }?.joinToString(", "),
                list("labels").takeIf { it.isNotEmpty() }?.joinToString(", "),
                list("issueTypes").takeIf { it.isNotEmpty() }?.joinToString(", "),
                list("statuses").takeIf { it.isNotEmpty() }?.let { "→ ${it.joinToString(", ")}" },
            ).joinToString(" · ")
            TriggerKind.PAGERDUTY -> listOfNotNull(
                kindsLine("Any PagerDuty incident event"),
                str("urgency")?.let { "$it urgency" },
                list("services").takeIf { it.isNotEmpty() }?.joinToString(", "),
            ).joinToString(" · ")
            TriggerKind.PYLON -> list("events").takeIf { it.isNotEmpty() }?.joinToString(", ") ?: "Any Pylon event"
            TriggerKind.SENTRY -> listOfNotNull(
                kindsLine("Any Sentry event"),
                list("projects").takeIf { it.isNotEmpty() }?.joinToString(", "),
                list("environments").takeIf { it.isNotEmpty() }?.joinToString(", "),
                list("levels").takeIf { it.isNotEmpty() }?.joinToString(", "),
            ).joinToString(" · ")
            TriggerKind.ALERTMANAGER -> listOfNotNull(
                kindsLine("Any alert group"),
                list("alertnames").takeIf { it.isNotEmpty() }?.joinToString(", "),
                list("severities").takeIf { it.isNotEmpty() }?.joinToString(", "),
                list("receivers").takeIf { it.isNotEmpty() }?.joinToString(", "),
            ).joinToString(" · ")
            TriggerKind.DATADOG -> listOfNotNull(
                kindsLine("Any monitor transition"),
                list("priorities").takeIf { it.isNotEmpty() }?.joinToString(", "),
                list("tags").takeIf { it.isNotEmpty() }?.joinToString(", "),
                list("monitors").takeIf { it.isNotEmpty() }?.joinToString(", "),
            ).joinToString(" · ")
            TriggerKind.UNKNOWN -> config.entries.joinToString(", ") { (k, v) -> "$k: ${v.stringValue ?: v}" }
        }
    }
}

/** Human cron and trigger descriptions (iOS `ScheduleFormat`). */
object ScheduleFormat {
    private val days = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")

    /** "Every day 09:00" / "Every Monday 09:00" / "Every hour" / "Every 6 hours" for common shapes; else the raw cron. */
    fun cron(expr: String): String {
        val f = expr.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (f.size != 5) return expr
        val m = f[0].toIntOrNull() ?: return expr
        val restAny = f[2] == "*" && f[3] == "*" && f[4] == "*"
        if (f[1] == "*") {
            if (!restAny) return expr
            return if (m == 0) "Every hour" else "Every hour at :" + String.format(Locale.US, "%02d", m)
        }
        Regex("^\\*/(\\d+)$").find(f[1])?.let { step ->
            if (m == 0 && restAny) return "Every ${step.groupValues[1]} hours"
            return expr
        }
        val hour = f[1].toIntOrNull() ?: return expr
        val time = String.format(Locale.US, "%02d:%02d", hour, m)
        if (f[2] == "*" && f[3] == "*") {
            if (f[4] == "*") return "Every day $time"
            if (f[4] == "1-5") return "Weekdays $time"
            f[4].toIntOrNull()?.takeIf { it in 0..6 }?.let { return "Every ${days[it]} $time" }
        }
        return expr
    }

    /** One phrase for a trigger in a header ("Every Monday 09:00", "GitHub tickets · bug"). */
    fun humanize(trigger: TriggerRow): String = when (trigger.kind) {
        TriggerKind.SCHEDULE -> trigger.cronExpression?.let(::cron) ?: "Schedule"
        TriggerKind.WEBHOOK -> "Webhook"
        TriggerKind.TICKET -> {
            val source = TriggerText.sourceLabel(trigger.ticketSource ?: "github")
            if (trigger.ticketLabels.isEmpty()) "$source tickets" else "$source tickets · ${trigger.ticketLabels.joinToString(", ")}"
        }
        TriggerKind.GITHUB -> "GitHub events"
        TriggerKind.GITLAB -> "GitLab events"
        TriggerKind.SLACK -> "Slack messages"
        TriggerKind.LINEAR -> "Linear events"
        TriggerKind.JIRA -> "Jira events"
        TriggerKind.PAGERDUTY -> "PagerDuty incidents"
        TriggerKind.PYLON -> "Pylon events"
        TriggerKind.SENTRY -> "Sentry alerts"
        TriggerKind.ALERTMANAGER -> "Alertmanager alerts"
        TriggerKind.DATADOG -> "Datadog monitors"
        TriggerKind.MANUAL, TriggerKind.UNKNOWN -> "Manual"
    }
}

/**
 * One trigger in an editor (the Job form's list, the Add trigger sheet): its [type] and full
 * [config] (keys the editor doesn't show survive an edit, since a PATCH replaces the config), and
 * for an existing row the id and what it was, so a save can diff it (iOS `TriggerDraft`).
 */
data class TriggerDraft(
    val key: String = UUID.randomUUID().toString(),
    val existingId: String? = null,
    val originalType: TriggerKind? = null,
    val originalConfig: JsonObject? = null,
    val originalEnabled: Boolean? = null,
    val type: TriggerKind = TriggerKind.MANUAL,
    val config: JsonObject = JsonObject(emptyMap()),
    val enabled: Boolean = true,
    val deleted: Boolean = false,
) {
    // Reads

    fun string(key: String): String = config[key]?.stringValue.orEmpty()

    fun bool(key: String): Boolean = config[key]?.boolValue == true

    fun strings(key: String): List<String> = config[key]?.arrayValue?.mapNotNull { it.stringValue }.orEmpty()

    val cron: String get() = string("cronExpression")
    val path: String get() = string("path")
    val secret: String get() = string("secret")
    val ticketSource: String get() = string("source").ifEmpty { "github" }
    val events: List<String> get() = strings("events")

    /** The event kinds [type] offers (GitHub / GitLab / Linear / Jira / PagerDuty / Sentry / Alertmanager / Datadog); empty for others (Pylon's are free text). */
    val eventKinds: List<EventKindOption>
        get() = TriggerText.kinds(type)

    /** The key naming whom personal events are about: `login` (GitHub) / `username` (GitLab) / `user` (Linear, Jira). */
    val personKey: String?
        get() = when (type) {
            TriggerKind.GITHUB -> "login"
            TriggerKind.GITLAB -> "username"
            TriggerKind.LINEAR, TriggerKind.JIRA -> "user"
            else -> null
        }

    /** GitHub / GitLab / Linear / Jira: a person is needed (no events picked = any, which includes personal ones). */
    val needsPerson: Boolean
        get() = personKey != null && (events.isEmpty() || eventKinds.any { it.personal && it.value in events })

    // Writes (each returns a copy)

    /** Switches type. Back to the saved type restores its config; otherwise the new type's defaults. */
    fun withType(kind: TriggerKind): TriggerDraft {
        if (kind == type) return this
        if (kind == originalType && originalConfig != null) return copy(type = kind, config = originalConfig)
        return copy(type = kind, config = defaultConfig(kind))
    }

    fun withString(key: String, value: String): TriggerDraft =
        copy(config = JsonObject(config + (key to JsonPrimitive(value))))

    fun withBool(key: String, value: Boolean): TriggerDraft =
        copy(config = JsonObject(config + (key to JsonPrimitive(value))))

    fun withStrings(key: String, values: List<String>): TriggerDraft =
        copy(config = JsonObject(config + (key to JsonArray(values.map(::JsonPrimitive)))))

    fun toggleEvent(value: String, on: Boolean): TriggerDraft {
        val next = if (on) (events + value).distinct() else events - value
        return withStrings("events", next)
    }

    // Validation and submission

    /** Why this can't be saved yet (the server's rules, iOS form copy); null when it can. */
    val problem: String?
        get() = when (type) {
            TriggerKind.SCHEDULE -> if (!TriggerText.cronIsValid(cron)) "Expected five space-separated fields." else null
            TriggerKind.WEBHOOK -> if (path.isBlank()) "A webhook needs a path." else null
            TriggerKind.TICKET -> null
            TriggerKind.GITHUB -> if (needsPerson && string("login").isBlank()) "Add the GitHub username that review, mention and assign events are about." else null
            TriggerKind.GITLAB -> if (needsPerson && string("username").isBlank()) "Add the GitLab username that review, mention and assign events are about." else null
            TriggerKind.SLACK -> if (!TriggerText.slackChannelId.matches(string("channelId"))) "Add the Slack channel id (e.g. C0123ABCD)." else null
            TriggerKind.LINEAR -> if (needsPerson && string("user").isBlank()) "Add the Linear user that assign and mention events are about." else null
            TriggerKind.JIRA -> if (needsPerson && string("user").isBlank()) "Add the Jira account id, display name or email that assign and mention events are about." else null
            // PagerDuty / Sentry / Alertmanager / Datadog: no kinds would mean every event — make it a choice. Pylon's events are optional.
            TriggerKind.PAGERDUTY -> if (events.isEmpty()) "Pick at least one PagerDuty incident event." else null
            TriggerKind.SENTRY -> if (events.isEmpty()) "Pick at least one Sentry event." else null
            TriggerKind.ALERTMANAGER -> if (events.isEmpty()) "Pick firing, resolved, or both." else null
            TriggerKind.DATADOG -> if (events.isEmpty()) "Pick at least one monitor transition." else null
            TriggerKind.PYLON, TriggerKind.MANUAL, TriggerKind.UNKNOWN -> null
        }

    val isValid: Boolean
        get() = problem == null

    /** The config to send: trimmed, with empty optional values dropped. */
    fun submitConfig(): JsonObject {
        val out = LinkedHashMap<String, JsonElement>()
        for ((k, v) in config) {
            val s = v.stringValue
            when {
                s != null && s.isBlank() -> Unit
                s != null -> out[k] = JsonPrimitive(if (k in PERSON_KEYS) s.trim().removePrefix("@") else s.trim())
                v is JsonArray && v.isEmpty() && (type == TriggerKind.TICKET || k == "events" || k in LIST_FILTER_KEYS) -> Unit
                else -> out[k] = v
            }
        }
        if (type == TriggerKind.TICKET && "source" !in out) out["source"] = JsonPrimitive("github")
        return JsonObject(out)
    }

    /** What a save does with this draft. */
    val change: Change
        get() = when {
            existingId == null && deleted -> Change.NONE
            existingId == null -> Change.CREATE
            deleted -> Change.DELETE
            type != originalType -> Change.REPLACE
            submitConfig() != originalConfig || enabled != originalEnabled -> Change.UPDATE
            else -> Change.NONE
        }

    /** A save's step for one draft (a type change is delete + create: the PATCH body has no type). */
    enum class Change { NONE, CREATE, UPDATE, REPLACE, DELETE }

    companion object {
        /** The config keys that name "you", trimmed of a leading `@` on submit. */
        private val PERSON_KEYS = setOf("login", "username", "user")

        /** The optional list filters an empty array is dropped for (the server reads a missing key as "any"). */
        private val LIST_FILTER_KEYS = setOf(
            "repos", "teams", "services", "projects", "branches", "workflows", "labels", "issueTypes", "statuses",
            "environments", "levels", "alertnames", "severities", "receivers", "priorities", "tags", "monitors",
        )

        /** A draft of an existing row. */
        fun of(row: TriggerRow): TriggerDraft {
            val config = JsonObject(row.config.orEmpty())
            return TriggerDraft(
                existingId = row.id,
                originalType = row.kind,
                originalConfig = config,
                originalEnabled = row.enabled,
                type = row.kind,
                config = config,
                enabled = row.enabled,
            )
        }

        /** A new trigger of [kind] with its defaults. */
        fun new(kind: TriggerKind = TriggerKind.MANUAL): TriggerDraft = TriggerDraft(type = kind, config = defaultConfig(kind))

        fun defaultConfig(kind: TriggerKind): JsonObject = when (kind) {
            TriggerKind.SCHEDULE -> JsonObject(mapOf("cronExpression" to JsonPrimitive("0 9 * * *")))
            TriggerKind.WEBHOOK -> JsonObject(mapOf("path" to JsonPrimitive(TriggerText.newWebhookPath())))
            TriggerKind.TICKET -> JsonObject(mapOf("source" to JsonPrimitive("github")))
            TriggerKind.SLACK -> JsonObject(mapOf("mentionOnly" to JsonPrimitive(false)))
            TriggerKind.PAGERDUTY -> JsonObject(mapOf("events" to JsonArray(listOf(JsonPrimitive("incident.triggered")))))
            TriggerKind.PYLON -> JsonObject(mapOf("events" to JsonArray(emptyList())))
            TriggerKind.SENTRY -> JsonObject(mapOf("events" to JsonArray(listOf(JsonPrimitive("issue_created")))))
            TriggerKind.ALERTMANAGER -> JsonObject(mapOf("events" to JsonArray(listOf(JsonPrimitive("firing")))))
            TriggerKind.DATADOG -> JsonObject(mapOf("events" to JsonArray(listOf(JsonPrimitive("triggered")))))
            else -> JsonObject(emptyMap())
        }
    }
}

private fun Map<String, JsonElement>?.string(key: String): String? = this?.get(key)?.stringValue

private fun Map<String, JsonElement>?.strings(key: String): List<String> = this?.get(key)?.arrayValue?.mapNotNull { it.stringValue }.orEmpty()
