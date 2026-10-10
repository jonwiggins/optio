package dev.optio.core.ui.triggers

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ConfirmationNumber
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.TouchApp
import androidx.compose.material.icons.outlined.Webhook
import androidx.compose.ui.graphics.vector.ImageVector
import dev.optio.core.ui.components.Brand
import dev.optio.core.ui.components.BrandIcons
import kotlin.random.Random
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// The trigger vocabulary every form shares (the web's `trigger-selector.tsx` and the per-type
// config shapes of `schemas/trigger.ts`; `TRIGGER_TYPES_FOR_TARGET` in `@optio/shared`): the New
// work form's When section, a Local automation's Add trigger sheet, and a persistent agent's New
// trigger sheet all draft the same [TriggerDraft], validate it with the same rules, and send the
// same [TriggerSpec]. Pure data and pure functions; the editor is in `TriggerEditor.kt`.

// region Types

/** The plain trigger types (`manual` / `schedule` / `webhook` / `ticket`). */
enum class TriggerType(val raw: String) {
    MANUAL("manual"),
    SCHEDULE("schedule"),
    WEBHOOK("webhook"),
    TICKET("ticket"),
    ;

    companion object {
        fun fromRaw(raw: String?): TriggerType? = entries.firstOrNull { it.raw == raw }
    }
}

/**
 * Event triggers: a GitHub / GitLab / Slack / Linear / Jira / Pylon / PagerDuty / Sentry /
 * Alertmanager / Datadog event starts the work (`EVENT_TRIGGER_TYPES` in `@optio/shared`).
 */
enum class EventTriggerType(val raw: String) {
    GITHUB("github"),
    GITLAB("gitlab"),
    SLACK("slack"),
    LINEAR("linear"),
    JIRA("jira"),
    PYLON("pylon"),
    PAGERDUTY("pagerduty"),
    SENTRY("sentry"),
    ALERTMANAGER("alertmanager"),
    DATADOG("datadog"),
    ;

    /**
     * Pylon, Alertmanager and Datadog can't sign their deliveries: each trigger carries its own
     * shared secret (minted on create, shown once) and listens at `/api/hooks/<type>/<trigger id>`.
     */
    val selfSecret: Boolean
        get() = this == PYLON || this == ALERTMANAGER || this == DATADOG

    companion object {
        fun fromRaw(raw: String?): EventTriggerType? = entries.firstOrNull { it.raw == raw }
    }
}

/** The fourteen things that can start work: a plain trigger type or an event. */
enum class WhenType(val raw: String, val label: String) {
    MANUAL("manual", "Now"),
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
    ;

    /** The event this When is, or null for a plain trigger. */
    val event: EventTriggerType?
        get() = EventTriggerType.fromRaw(raw)

    val isEvent: Boolean
        get() = event != null

    /** The plain trigger type this When is, or null for an event. */
    val trigger: TriggerType?
        get() = TriggerType.fromRaw(raw)

    /** The answer as a menu shows it (iOS `menuLabel`): "On a schedule". */
    val menuLabel: String
        get() = when (this) {
            MANUAL -> "Now"
            SCHEDULE -> "On a schedule"
            WEBHOOK -> "By webhook"
            TICKET -> "From a ticket"
            GITHUB -> "GitHub event"
            GITLAB -> "GitLab event"
            SLACK -> "Slack message"
            LINEAR -> "Linear event"
            JIRA -> "Jira event"
            PYLON -> "Pylon event"
            PAGERDUTY -> "PagerDuty incident"
            SENTRY -> "Sentry alert"
            ALERTMANAGER -> "Alertmanager alert"
            DATADOG -> "Datadog monitor"
        }

    /** The type as a trigger row names it ("Manual" rather than the form's "Now"). */
    val typeLabel: String
        get() = if (this == MANUAL) "Manual" else label

    /** The brand of the service it listens to, if any. */
    val brand: Brand?
        get() = Brand.fromProvider(raw)

    /** The mark beside the type: the brand's logo for an event, a Material icon otherwise. */
    val icon: ImageVector
        get() = brand?.icon ?: when (this) {
            MANUAL -> Icons.Outlined.PlayArrow
            SCHEDULE -> Icons.Outlined.Schedule
            WEBHOOK -> Icons.Outlined.Webhook
            else -> Icons.Outlined.ConfirmationNumber
        }

    /** The mark a trigger row wears: a hand for manual (the form's "Now" is a play glyph). */
    val rowIcon: ImageVector
        get() = if (this == MANUAL) Icons.Outlined.TouchApp else icon

    companion object {
        fun fromRaw(raw: String?): WhenType? = entries.firstOrNull { it.raw == raw }

        /** The types a trigger sheet offers: everything but [MANUAL] (and it too when [withManual]). */
        fun forSheet(withManual: Boolean = false): List<WhenType> = entries.filter { withManual || it != MANUAL }
    }
}

/** Where ticket triggers read from. */
enum class TicketSource(val raw: String, val label: String) {
    GITHUB("github", "GitHub"),
    GITLAB("gitlab", "GitLab"),
    LINEAR("linear", "Linear"),
    JIRA("jira", "Jira"),
    NOTION("notion", "Notion"),
    ;

    /** The source's logo. */
    val icon: ImageVector
        get() = Brand.fromProvider(raw)?.icon ?: Icons.Outlined.ConfirmationNumber

    companion object {
        fun fromRaw(raw: String?): TicketSource? = entries.firstOrNull { it.raw == raw }
    }
}

/** `TriggerConfig` in trigger-selector.tsx: a plain trigger's answers. */
data class TriggerConfig(
    val type: TriggerType = TriggerType.MANUAL,
    val cronExpression: String? = null,
    val webhookPath: String? = null,
    val ticketSource: TicketSource? = null,
    val ticketLabels: List<String>? = null,
) {
    companion object {
        val MANUAL = TriggerConfig()
    }
}

/**
 * An event trigger's config, in the shape the trigger routes store: GitHub
 * `{ events, login, repos? }`, Slack `{ channelId, mentionOnly, keyword?, includeThreads? }`,
 * Linear `{ events, user, teams?, labels? }`, …
 */
data class EventTrigger(
    val type: EventTriggerType,
    val config: JsonObject,
) {
    companion object {
        fun default(type: EventTriggerType): EventTrigger = EventTrigger(type, defaultEventConfig(type))
    }
}

/** A fresh event config for [type] (`DEFAULT_EVENT_CONFIG` in work-form.tsx). */
fun defaultEventConfig(type: EventTriggerType): JsonObject = when (type) {
    EventTriggerType.GITHUB -> jsonObjectOf("events" to jsonArrayOf("review_requested", "mentioned"), "login" to JsonPrimitive(""))
    EventTriggerType.SLACK -> jsonObjectOf("channelId" to JsonPrimitive(""), "mentionOnly" to JsonPrimitive(false))
    EventTriggerType.LINEAR -> jsonObjectOf("events" to jsonArrayOf("assigned", "mentioned"), "user" to JsonPrimitive(""))
    EventTriggerType.GITLAB -> jsonObjectOf("events" to jsonArrayOf("review_requested", "mentioned"), "username" to JsonPrimitive(""))
    EventTriggerType.JIRA -> jsonObjectOf("events" to jsonArrayOf("assigned", "mentioned"), "user" to JsonPrimitive(""))
    EventTriggerType.PAGERDUTY -> jsonObjectOf("events" to jsonArrayOf("incident.triggered"))
    EventTriggerType.PYLON -> jsonObjectOf("events" to jsonArrayOf())
    EventTriggerType.SENTRY -> jsonObjectOf("events" to jsonArrayOf("issue_created"))
    EventTriggerType.ALERTMANAGER -> jsonObjectOf("events" to jsonArrayOf("firing"))
    EventTriggerType.DATADOG -> jsonObjectOf("events" to jsonArrayOf("triggered"))
}

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

// endregion

// region Cron / webhook helpers (trigger-selector.tsx)

data class CronPreset(val label: String, val expr: String)

val CRON_PRESETS: List<CronPreset> = listOf(
    CronPreset("Every hour", "0 * * * *"),
    CronPreset("Every 6h", "0 */6 * * *"),
    CronPreset("Daily 09:00 UTC", "0 9 * * *"),
    CronPreset("Weekdays 09:00 UTC", "0 9 * * 1-5"),
    CronPreset("Mon 09:00 UTC", "0 9 * * 1"),
)

/** Plain English for the cron presets, for the sentence and the summaries. */
val CRON_WORDS: Map<String, String> = mapOf(
    "0 * * * *" to "every hour",
    "0 */6 * * *" to "every 6 hours",
    "0 9 * * *" to "daily at 09:00 UTC",
    "0 9 * * 1-5" to "weekdays at 09:00 UTC",
    "0 9 * * 1" to "Mondays at 09:00 UTC",
)

private val WHITESPACE = Regex("\\s+")

/** Five whitespace-separated fields. */
fun cronIsValid(expr: String?): Boolean {
    val trimmed = expr?.trim().orEmpty()
    if (trimmed.isEmpty()) return false
    return trimmed.split(WHITESPACE).size == 5
}

/** `hook-` plus 8 random lowercase letters and digits. */
fun randomWebhookPath(random: Random = Random.Default): String {
    val alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    return "hook-" + (1..8).map { alphabet[random.nextInt(alphabet.length)] }.joinToString("")
}

/** The public path a webhook trigger listens on: `POST <server>/api/hooks/<path>`. */
fun webhookPath(path: String): String = "/api/hooks/$path"

/** The path a self-secret trigger (Pylon, Alertmanager, Datadog) listens on, once it has an id. */
fun selfSecretPath(type: EventTriggerType, triggerId: String): String = "/api/hooks/${type.raw}/$triggerId"

// endregion

// region Event kinds (local/automations-section.tsx)

data class EventKind(val value: String, val label: String, val personal: Boolean)

val GITHUB_KINDS: List<EventKind> = listOf(
    EventKind("review_requested", "Review requested from me", personal = true),
    EventKind("mentioned", "I'm @-mentioned", personal = true),
    EventKind("assigned", "Assigned to me", personal = true),
    EventKind("pr_opened", "Any PR opened", personal = false),
    EventKind("issue_opened", "Any issue opened", personal = false),
    EventKind("pr_merged", "A PR is merged", personal = false),
    EventKind("labeled", "A label is added", personal = false),
    EventKind("push", "A branch is pushed", personal = false),
    EventKind("release_published", "A release is published", personal = false),
    EventKind("workflow_succeeded", "A workflow run passes", personal = false),
    EventKind("workflow_failed", "A workflow run fails", personal = false),
)

/** GitHub's kinds in GitLab's words (`GITLAB_EVENT_KINDS`). */
val GITLAB_KINDS: List<EventKind> = listOf(
    EventKind("review_requested", "Review requested from me", personal = true),
    EventKind("mentioned", "I'm @-mentioned", personal = true),
    EventKind("assigned", "Assigned to me", personal = true),
    EventKind("mr_opened", "Any MR opened", personal = false),
    EventKind("mr_merged", "An MR is merged", personal = false),
    EventKind("issue_opened", "Any issue opened", personal = false),
    EventKind("labeled", "A label is added", personal = false),
    EventKind("push", "A branch is pushed", personal = false),
    EventKind("release_published", "A release is published", personal = false),
    EventKind("pipeline_succeeded", "A pipeline passes", personal = false),
    EventKind("pipeline_failed", "A pipeline fails", personal = false),
)

val LINEAR_KINDS: List<EventKind> = listOf(
    EventKind("assigned", "Assigned to me", personal = true),
    EventKind("mentioned", "I'm @-mentioned", personal = true),
    EventKind("created", "Any issue created", personal = false),
    EventKind("labeled", "A label is added", personal = false),
)

/** Jira Cloud issue / comment events (`JIRA_EVENT_KINDS`). */
val JIRA_KINDS: List<EventKind> = listOf(
    EventKind("assigned", "Assigned to me", personal = true),
    EventKind("mentioned", "I'm mentioned", personal = true),
    EventKind("created", "Any issue created", personal = false),
    EventKind("commented", "A comment is added", personal = false),
    EventKind("transitioned", "Status changes", personal = false),
    EventKind("labeled", "A label is added", personal = false),
)

/** Sentry internal-integration webhooks (`SENTRY_EVENT_KINDS`); none is about you. */
val SENTRY_KINDS: List<EventKind> = listOf(
    EventKind("issue_created", "New issue", personal = false),
    EventKind("issue_unresolved", "Issue regressed", personal = false),
    EventKind("issue_resolved", "Issue resolved", personal = false),
    EventKind("issue_assigned", "Issue assigned", personal = false),
    EventKind("issue_archived", "Issue archived", personal = false),
    EventKind("alert_triggered", "Issue alert fires", personal = false),
    EventKind("metric_alert_critical", "Metric alert critical", personal = false),
    EventKind("metric_alert_warning", "Metric alert warning", personal = false),
    EventKind("metric_alert_resolved", "Metric alert resolved", personal = false),
)

/** Alertmanager / Grafana alert groups (`ALERTMANAGER_EVENT_KINDS`): the group's status. */
val ALERTMANAGER_KINDS: List<EventKind> = listOf(
    EventKind("firing", "Alerts firing", personal = false),
    EventKind("resolved", "Alerts resolved", personal = false),
)

/** Datadog monitor transitions (`DATADOG_EVENT_KINDS`). */
val DATADOG_KINDS: List<EventKind> = listOf(
    EventKind("triggered", "Monitor triggered", personal = false),
    EventKind("warning", "Monitor warning", personal = false),
    EventKind("no_data", "No data", personal = false),
    EventKind("recovered", "Monitor recovered", personal = false),
)

/** PagerDuty Webhooks v3 incident events (`PAGERDUTY_EVENT_KINDS`); none is about you. */
val PAGERDUTY_KINDS: List<EventKind> = listOf(
    EventKind("incident.triggered", "Incident triggered", personal = false),
    EventKind("incident.acknowledged", "Incident acknowledged", personal = false),
    EventKind("incident.unacknowledged", "Incident unacknowledged", personal = false),
    EventKind("incident.resolved", "Incident resolved", personal = false),
    EventKind("incident.escalated", "Incident escalated", personal = false),
    EventKind("incident.reassigned", "Incident reassigned", personal = false),
    EventKind("incident.delegated", "Incident delegated", personal = false),
    EventKind("incident.reopened", "Incident reopened", personal = false),
    EventKind("incident.priority_updated", "Priority updated", personal = false),
    EventKind("incident.responder.added", "Responder added", personal = false),
    EventKind("incident.responder.replied", "Responder replied", personal = false),
    EventKind("incident.status_update_published", "Status update published", personal = false),
    EventKind("incident.annotated", "Incident annotated", personal = false),
)

/** The kinds an event trigger offers; empty for Slack and Pylon (whose kinds are free text). */
fun eventKinds(type: EventTriggerType): List<EventKind> = when (type) {
    EventTriggerType.GITHUB -> GITHUB_KINDS
    EventTriggerType.GITLAB -> GITLAB_KINDS
    EventTriggerType.LINEAR -> LINEAR_KINDS
    EventTriggerType.JIRA -> JIRA_KINDS
    EventTriggerType.PAGERDUTY -> PAGERDUTY_KINDS
    EventTriggerType.SENTRY -> SENTRY_KINDS
    EventTriggerType.ALERTMANAGER -> ALERTMANAGER_KINDS
    EventTriggerType.DATADOG -> DATADOG_KINDS
    EventTriggerType.SLACK, EventTriggerType.PYLON -> emptyList()
}

/** GitHub / GitLab / Linear / Jira event kinds that are "about you" and need an identity to match. */
val PERSONAL_EVENT_KINDS: Map<EventTriggerType, List<String>> = mapOf(
    EventTriggerType.GITHUB to listOf("review_requested", "mentioned", "assigned"),
    EventTriggerType.GITLAB to listOf("review_requested", "mentioned", "assigned"),
    EventTriggerType.SLACK to emptyList(),
    EventTriggerType.LINEAR to listOf("assigned", "mentioned"),
    EventTriggerType.JIRA to listOf("assigned", "mentioned"),
    EventTriggerType.PAGERDUTY to emptyList(),
    EventTriggerType.PYLON to emptyList(),
    EventTriggerType.SENTRY to emptyList(),
    EventTriggerType.ALERTMANAGER to emptyList(),
    EventTriggerType.DATADOG to emptyList(),
)

/** Slack channel ids look like C0123ABCD (the API rejects anything else). */
val SLACK_CHANNEL_ID = Regex("^[A-Z][A-Z0-9]{5,}$")

/** The config key that names "you" for an event trigger: `login` (GitHub), `username` (GitLab) or `user` (Linear, Jira). */
fun identityKey(type: EventTriggerType): String = when (type) {
    EventTriggerType.GITHUB -> "login"
    EventTriggerType.GITLAB -> "username"
    else -> "user"
}

/** The event kinds an event config has checked. */
fun eventsOf(config: JsonObject): List<String> = config.strings("events")

/**
 * The comma-list filters each source offers (`key`, label, placeholder); an empty one means
 * "any". Slack and Pylon have none.
 */
fun eventFilters(type: EventTriggerType): List<EventFilter> = when (type) {
    EventTriggerType.GITHUB -> listOf(
        EventFilter("repos", "Only these repos", "owner/name, owner/other"),
        EventFilter("branches", "Only these branches", "main, release/*"),
        EventFilter("workflows", "Only these workflows", "CI, Deploy"),
        EventFilter("labels", "Only with a label", "bug, triage"),
    )
    EventTriggerType.GITLAB -> listOf(
        EventFilter("projects", "Only these projects", "group/project"),
        EventFilter("branches", "Only these branches", "main, release/*"),
        EventFilter("labels", "Only with a label", "bug, triage"),
    )
    EventTriggerType.LINEAR -> listOf(
        EventFilter("teams", "Only these teams", "ENG, OPS"),
        EventFilter("labels", "Only with a label", "bug, triage"),
    )
    EventTriggerType.JIRA -> listOf(
        EventFilter("projects", "Only these projects", "ENG, OPS"),
        EventFilter("labels", "Only with a label", "bug, triage"),
        EventFilter("issueTypes", "Only these issue types", "Bug, Story"),
        EventFilter("statuses", "Only into these statuses", "In Progress, Done"),
    )
    EventTriggerType.PAGERDUTY -> listOf(EventFilter("services", "Only these services", "Checkout API, PROD1"))
    EventTriggerType.SENTRY -> listOf(
        EventFilter("projects", "Only these projects", "web, api"),
        EventFilter("environments", "Only these environments", "production"),
        EventFilter("levels", "Only these levels", "fatal, error"),
    )
    EventTriggerType.ALERTMANAGER -> listOf(
        EventFilter("alertnames", "Only these alerts", "HighErrorRate, PodCrashLooping"),
        EventFilter("severities", "Only these severities", "critical, warning"),
        EventFilter("receivers", "Only these receivers", "optio"),
    )
    EventTriggerType.DATADOG -> listOf(
        EventFilter("priorities", "Only these priorities", "P1, P2"),
        EventFilter("tags", "Only with a tag", "env:prod, team:core"),
        EventFilter("monitors", "Only these monitors", "Checkout latency, 123456"),
    )
    EventTriggerType.SLACK, EventTriggerType.PYLON -> emptyList()
}

data class EventFilter(val key: String, val label: String, val placeholder: String)

// endregion

// region Trigger params

/**
 * The `{{param}}`s a prompt (or a command) can use, per trigger: what the trigger worker, the
 * webhook receiver and the event services put in `params`.
 */
val TRIGGER_PARAMS: Map<WhenType, List<String>> = mapOf(
    WhenType.MANUAL to emptyList(),
    WhenType.SCHEDULE to emptyList(),
    WhenType.WEBHOOK to emptyList(),
    WhenType.TICKET to listOf("ticketSource", "ticketExternalId", "ticketTitle", "ticketBody", "ticketUrl", "ticketLabels"),
    WhenType.GITHUB to listOf(
        "event", "kind", "repo", "repoUrl", "number", "title", "body", "url", "author", "headBranch", "baseBranch",
        "commentBody", "commentUrl", "action", "labels", "label", "ref", "sha", "commits", "compareUrl", "tag", "workflow",
        "conclusion", "merged",
    ),
    WhenType.GITLAB to listOf(
        "event", "kind", "project", "projectUrl", "iid", "title", "body", "url", "author", "sourceBranch", "targetBranch",
        "commentBody", "commentUrl", "labels", "label", "ref", "sha", "commits", "compareUrl", "tag", "pipelineStatus", "action",
    ),
    WhenType.SLACK to listOf("channelId", "userId", "text", "ts", "threadTs", "permalink", "botName"),
    WhenType.LINEAR to listOf(
        "event", "identifier", "title", "description", "url", "labels", "teamKey", "assignee", "priority", "state",
        "commentBody", "commentUrl", "actor", "ticketTitle", "ticketBody", "ticketUrl", "ticketLabels",
    ),
    WhenType.JIRA to listOf(
        "event", "key", "title", "description", "url", "project", "projectName", "status", "previousStatus", "assignee",
        "priority", "labels", "issueType", "commentBody", "commentUrl", "actor", "ticketSource", "ticketExternalId",
        "ticketTitle", "ticketBody", "ticketUrl", "ticketLabels",
    ),
    WhenType.PAGERDUTY to listOf(
        "event", "incidentId", "incidentNumber", "title", "url", "urgency", "priority", "service", "serviceId", "status",
        "assignees", "ticketSource", "ticketExternalId", "ticketTitle", "ticketUrl",
    ),
    WhenType.PYLON to listOf(
        "event", "issueId", "issueNumber", "title", "body", "state", "url", "account", "requester", "assignee", "tags", "payload",
    ),
    WhenType.SENTRY to listOf(
        "event", "resource", "action", "issueId", "shortId", "title", "culprit", "level", "project", "projectName", "url",
        "environment", "status", "assignee", "count", "userCount", "firstSeen", "lastSeen", "actor", "alertRule",
        "ticketSource", "ticketExternalId", "ticketTitle", "ticketUrl",
    ),
    WhenType.ALERTMANAGER to listOf(
        "event", "status", "receiver", "groupKey", "title", "message", "alertnames", "severities", "count", "firing",
        "resolved", "externalUrl", "labels", "annotations", "alerts", "payload",
    ),
    WhenType.DATADOG to listOf(
        "event", "transition", "alertType", "eventId", "alertId", "title", "body", "link", "priority", "status", "tags",
        "hostname", "query", "scope", "metric", "org", "date", "payload",
    ),
)

fun triggerParams(whenType: WhenType): List<String> = TRIGGER_PARAMS[whenType].orEmpty()

// endregion

// region Draft

/** What a trigger still needs before the API would accept it. */
enum class TriggerGap {
    /** A schedule without five cron fields. */
    CRON,

    /** A webhook with a blank path, or one that isn't a single segment. */
    WEBHOOK,

    /** A Slack trigger without a channel id the API takes. */
    CHANNEL,

    /** An event trigger with no kind checked. */
    EVENTS,

    /** A personal kind ("assigned to me") without a login / user to match. */
    IDENTITY,
    ;

    /** The gap in words, for a sheet's footer. */
    val message: String
        get() = when (this) {
            CRON -> "Expected five space-separated fields."
            WEBHOOK -> "Pick a path for the webhook: one segment, no spaces or slashes."
            CHANNEL -> "Slack channel ids look like C0123ABCD."
            EVENTS -> "Pick at least one event."
            IDENTITY -> "Add your username — review, mention and assign events are about someone."
        }
}

/**
 * What an event trigger still needs before the API would accept it: the same rules the trigger
 * routes enforce, checked up front so a rejected trigger never strands a half-created row.
 */
fun eventGaps(e: EventTrigger): List<TriggerGap> {
    val c = e.config
    if (e.type == EventTriggerType.SLACK) {
        return if (SLACK_CHANNEL_ID.matches(c.string("channelId"))) emptyList() else listOf(TriggerGap.CHANNEL)
    }
    // Pylon's kinds are free text and optional: nothing to fill in.
    if (e.type == EventTriggerType.PYLON) return emptyList()
    val events = eventsOf(c)
    // No kinds checked would mean "every kind" to the matcher: make it a choice.
    if (events.isEmpty()) return listOf(TriggerGap.EVENTS)
    val personal = events.any { it in PERSONAL_EVENT_KINDS[e.type].orEmpty() } ||
        // Linear's "only tickets from someone else" skips yours: it has to know you.
        (e.type == EventTriggerType.LINEAR && c.bool("othersOnly"))
    val identity = c.string(identityKey(e.type)).trim()
    if (personal && identity.isEmpty()) return listOf(TriggerGap.IDENTITY)
    return emptyList()
}

/**
 * One trigger as a form drafts it: the When answer, the plain trigger's config and the event's
 * config (each kept while the other is picked, so switching type and back keeps what was typed).
 */
data class TriggerDraft(
    val whenType: WhenType = WhenType.MANUAL,
    val trigger: TriggerConfig = TriggerConfig.MANUAL,
    val event: EventTrigger = EventTrigger.default(EventTriggerType.GITHUB),
) {
    /**
     * The draft with [w] picked: a fresh event config when the event changes, and a plain
     * trigger's defaults filled in the first time it is picked (a daily cron, a random hook path,
     * GitHub tickets).
     */
    fun select(w: WhenType): TriggerDraft {
        val ev = w.event
        if (ev != null) {
            return copy(whenType = w, trigger = trigger.copy(type = TriggerType.MANUAL), event = if (event.type == ev) event else EventTrigger.default(ev))
        }
        var t = trigger.copy(type = w.trigger ?: TriggerType.MANUAL)
        if (t.type == TriggerType.SCHEDULE && t.cronExpression == null) t = t.copy(cronExpression = "0 9 * * *")
        if (t.type == TriggerType.WEBHOOK && t.webhookPath == null) t = t.copy(webhookPath = randomWebhookPath())
        if (t.type == TriggerType.TICKET) {
            t = t.copy(ticketSource = t.ticketSource ?: TicketSource.GITHUB, ticketLabels = t.ticketLabels ?: emptyList())
        }
        return copy(whenType = w, trigger = t)
    }

    /** What is still missing, in the order the form shows it. */
    val gaps: List<TriggerGap>
        get() = when (whenType) {
            WhenType.MANUAL -> emptyList()
            WhenType.SCHEDULE -> if (cronIsValid(trigger.cronExpression)) emptyList() else listOf(TriggerGap.CRON)
            WhenType.WEBHOOK -> {
                val path = trigger.webhookPath.orEmpty().trim()
                if (path.isEmpty() || path.any { it.isWhitespace() || it == '/' }) listOf(TriggerGap.WEBHOOK) else emptyList()
            }
            WhenType.TICKET -> emptyList()
            else -> eventGaps(EventTrigger(whenType.event!!, event.config))
        }

    /** Why it can't be saved yet, in words; null when it can. */
    val problem: String?
        get() = gaps.firstOrNull()?.message

    val isValid: Boolean
        get() = gaps.isEmpty()

    /**
     * The row to send, or null for a manual start (nothing to attach: the work starts by hand).
     * A plain trigger is read from [TriggerConfig.type] (the form keeps it in step with [whenType]).
     */
    fun spec(): TriggerSpec? {
        whenType.event?.let { return TriggerSpec(it.raw, event.config) }
        val t = trigger
        return when (t.type) {
            TriggerType.MANUAL -> null
            TriggerType.SCHEDULE -> TriggerSpec("schedule", jsonObjectOf("cronExpression" to JsonPrimitive(t.cronExpression.orEmpty().trim())))
            TriggerType.WEBHOOK -> TriggerSpec("webhook", jsonObjectOf("path" to JsonPrimitive(t.webhookPath.orEmpty().trim())))
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

    /** A `manual` row too, for targets that store one (a persistent agent's "by hand"). */
    fun specOrManual(): TriggerSpec = spec() ?: TriggerSpec("manual", JsonObject(emptyMap()))

    /** The footer under the type's fields: the gap, else what the trigger does ([verb]: "starts a run" / "wakes the agent"). */
    fun footer(verb: String = "starts a run"): String {
        problem?.let { return it }
        return when (whenType) {
            WhenType.MANUAL -> "Fires only when someone runs it by hand."
            WhenType.SCHEDULE -> CRON_WORDS[trigger.cronExpression?.trim()]?.let { "${verb.replaceFirstChar(Char::uppercase)} $it." } ?: "Five-field cron expression, in UTC."
            WhenType.WEBHOOK -> "POST to this path and it $verb. The path must be unique across the workspace."
            WhenType.TICKET -> "Only tickets with at least one matching label count. No labels matches every ticket from the source."
            else -> "Each matching event $verb, with the event's fields available as {{param}}s."
        }
    }

    companion object {
        /** A draft for one type, with that type's defaults. */
        fun of(w: WhenType): TriggerDraft = TriggerDraft().select(w)

        /** A stored trigger's row (`type` + `config`) as a draft, for editing in place. */
        fun fromRow(type: String, config: JsonObject?): TriggerDraft {
            val c = config ?: JsonObject(emptyMap())
            EventTriggerType.fromRaw(type)?.let { ev -> return TriggerDraft(WhenType.fromRaw(type)!!, TriggerConfig.MANUAL, EventTrigger(ev, c)) }
            return when (type) {
                "schedule" -> TriggerDraft(WhenType.SCHEDULE, TriggerConfig(TriggerType.SCHEDULE, cronExpression = c.string("cronExpression")))
                "webhook" -> TriggerDraft(WhenType.WEBHOOK, TriggerConfig(TriggerType.WEBHOOK, webhookPath = c.string("path")))
                "ticket" -> TriggerDraft(
                    WhenType.TICKET,
                    TriggerConfig(
                        TriggerType.TICKET,
                        ticketSource = TicketSource.fromRaw(c.string("source")) ?: TicketSource.GITHUB,
                        ticketLabels = c.strings("labels"),
                    ),
                )
                else -> TriggerDraft()
            }
        }
    }
}

// endregion

// region Summaries

/**
 * One line saying what fires a stored trigger (its row in every list): `0 9 * * 1-5 · weekdays at
 * 09:00 UTC`, `/api/hooks/docs`, `Linear · docs, cleanup`, `review requested, mentioned ·
 * @octocat · acme/web`, `#C0123ABCD · @-mentions only · “docs”`, `By hand`.
 */
fun triggerSummary(type: String, config: JsonObject?): String {
    val c = config ?: JsonObject(emptyMap())
    fun string(key: String) = c.string(key).takeIf { it.isNotBlank() }
    fun strings(key: String) = c.strings(key)
    fun events(): String = strings("events").map { it.replace('_', ' ').replace('.', ' ') }.ifEmpty { listOf("any event") }.joinToString(", ")
    fun parts(vararg items: String?): String = items.filterNotNull().filter { it.isNotEmpty() }.joinToString(" · ")
    // One part per filter ("ENG · Done"), the values of a filter comma-joined ("bug, p1").
    fun scope(vararg keys: String): String? = keys.mapNotNull { strings(it).takeIf { v -> v.isNotEmpty() }?.joinToString(", ") }.takeIf { it.isNotEmpty() }?.joinToString(" · ")
    return when (WhenType.fromRaw(type)) {
        WhenType.SCHEDULE -> {
            val cron = string("cronExpression")?.trim() ?: return "cron"
            CRON_WORDS[cron]?.let { "$cron · $it" } ?: cron
        }
        WhenType.WEBHOOK -> string("path")?.let(::webhookPath) ?: "webhook"
        WhenType.TICKET -> {
            val source = string("source")?.let { TicketSource.fromRaw(it)?.label ?: it.replaceFirstChar(Char::titlecase) } ?: "Ticket"
            val labels = strings("labels")
            if (labels.isEmpty()) "$source · any label" else "$source · ${labels.joinToString(", ")}"
        }
        WhenType.GITHUB -> parts(events(), string("login")?.let { "@$it" }, scope("repos", "branches", "workflows", "labels"))
        WhenType.GITLAB -> parts(events(), string("username")?.let { "@$it" }, scope("projects", "branches", "labels"))
        WhenType.LINEAR -> parts(events(), string("user"), scope("teams", "labels"), if (c.bool("othersOnly")) "from others" else null)
        WhenType.JIRA -> parts(events(), string("user"), scope("projects", "labels", "issueTypes", "statuses"))
        WhenType.SLACK -> parts(
            "#" + (string("channelId") ?: "channel"),
            if (c.bool("mentionOnly")) "@-mentions only" else null,
            string("keyword")?.let { "“$it”" },
            if (c.bool("includeThreads")) "with threads" else null,
        )
        WhenType.PAGERDUTY -> parts(events(), scope("services"), string("urgency")?.let { "$it urgency" })
        WhenType.PYLON -> parts(events())
        WhenType.SENTRY -> parts(events(), scope("projects", "environments", "levels"))
        WhenType.ALERTMANAGER -> parts(events(), scope("alertnames", "severities", "receivers"))
        WhenType.DATADOG -> parts(events(), scope("priorities", "tags", "monitors"))
        WhenType.MANUAL -> "By hand"
        null -> type
    }
}

// endregion

// region JSON helpers

fun jsonObjectOf(vararg pairs: Pair<String, JsonElement>): JsonObject = JsonObject(linkedMapOf(*pairs))

fun jsonArrayOf(vararg values: String): JsonArray = JsonArray(values.map(::JsonPrimitive))

/** [this] with [key] set to [value] (keeps key order; a new key goes last). */
fun JsonObject.with(key: String, value: JsonElement): JsonObject = JsonObject(LinkedHashMap(this).apply { put(key, value) })

/** [this] without [key] (an "any" filter the server should read as unset rather than null). */
fun JsonObject.without(key: String): JsonObject = JsonObject(this - key)

/** The string at [key], or "" (`String(c[key] ?? "")` for strings). */
fun JsonObject.string(key: String): String = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()

fun JsonObject.bool(key: String): Boolean = (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull ?: false

/** A string list at [key] (comma lists in the event filters). */
fun JsonObject.strings(key: String): List<String> =
    (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.orEmpty()

// endregion
