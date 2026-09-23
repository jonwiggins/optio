package dev.optio.feature.agents

import dev.optio.core.model.arrayValue
import dev.optio.core.model.boolValue
import dev.optio.core.model.stringValue
import kotlin.random.Random
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The seven things that can wake a persistent agent (`@optio/shared` `TRIGGER_TYPES`; every one is
 * allowed for `target_type = "persistent_agent"`). A firing wakes the agent by writing a system
 * message into its inbox. Order is the sheet's: the useful ones first, Manual last.
 */
enum class AgentTriggerType(val raw: String, val label: String) {
    SCHEDULE("schedule", "Schedule"),
    WEBHOOK("webhook", "Webhook"),
    TICKET("ticket", "Ticket"),
    GITHUB("github", "GitHub"),
    SLACK("slack", "Slack"),
    LINEAR("linear", "Linear"),
    MANUAL("manual", "Manual"),
    ;

    companion object {
        fun fromRaw(raw: String): AgentTriggerType? = entries.firstOrNull { it.raw == raw }
    }
}

/** One event a GitHub / Linear trigger can listen for (iOS `WorkForm.EventKind`). */
data class AgentEventKind(val value: String, val label: String, val personal: Boolean)

/**
 * Pure trigger helpers: presets, the event vocabularies, one-line summaries, and the form draft →
 * `config` mapping with the server's validation rules (`trigger-service.validateTriggerConfig`).
 */
object AgentTriggers {
    /** `trigger-selector.tsx` `CRON_PRESETS` (iOS `WorkForm.cronPresets`). */
    val cronPresets: List<Pair<String, String>> =
        listOf(
            "Every hour" to "0 * * * *",
            "Every 6h" to "0 */6 * * *",
            "Daily 09:00 UTC" to "0 9 * * *",
            "Weekdays 09:00 UTC" to "0 9 * * 1-5",
            "Mon 09:00 UTC" to "0 9 * * 1",
        )

    /** The presets in words (iOS `WorkForm.cronWords`). */
    val cronWords: Map<String, String> =
        mapOf(
            "0 * * * *" to "every hour",
            "0 */6 * * *" to "every 6 hours",
            "0 9 * * *" to "daily at 09:00 UTC",
            "0 9 * * 1-5" to "weekdays at 09:00 UTC",
            "0 9 * * 1" to "Mondays at 09:00 UTC",
        )

    val ticketSources: List<String> = listOf("github", "linear", "jira", "notion")

    val githubKinds: List<AgentEventKind> =
        listOf(
            AgentEventKind("review_requested", "Review requested from me", personal = true),
            AgentEventKind("mentioned", "I'm @-mentioned", personal = true),
            AgentEventKind("assigned", "Assigned to me", personal = true),
            AgentEventKind("pr_opened", "Any PR opened", personal = false),
            AgentEventKind("issue_opened", "Any issue opened", personal = false),
        )

    val linearKinds: List<AgentEventKind> =
        listOf(
            AgentEventKind("assigned", "Assigned to me", personal = true),
            AgentEventKind("mentioned", "I'm @-mentioned", personal = true),
            AgentEventKind("created", "Any issue created", personal = false),
            AgentEventKind("labeled", "A label is added", personal = false),
        )

    /** `trigger-service.ts` `SLACK_CHANNEL_ID`. */
    private val slackChannelId = Regex("^[A-Z][A-Z0-9]{5,}$")

    /** A Slack channel id the server accepts (`C0123ABCD`). */
    fun isSlackChannelId(value: String): Boolean = slackChannelId.matches(value.trim())

    /** Five whitespace-separated fields (web `cronIsValid`). */
    fun cronIsValid(expr: String?): Boolean = expr?.trim()?.split(Regex("\\s+"))?.size == 5

    /** `hook-` + 8 random lowercase letters and digits (web `setType("webhook")`). */
    fun randomWebhookPath(random: Random = Random): String {
        val alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
        return "hook-" + (1..8).map { alphabet[random.nextInt(alphabet.length)] }.joinToString("")
    }

    /** The public URL a webhook trigger listens on: `POST <server>/api/hooks/<path>`. */
    fun webhookPath(path: String): String = "/api/hooks/$path"

    /** A one-line description of a stored trigger for its row. */
    fun summary(type: String, config: Map<String, JsonElement>): String {
        fun string(key: String) = config[key]?.stringValue?.takeIf { it.isNotBlank() }
        fun strings(key: String) = config[key]?.arrayValue?.mapNotNull { it.stringValue }.orEmpty()
        return when (AgentTriggerType.fromRaw(type)) {
            AgentTriggerType.SCHEDULE -> {
                val cron = string("cronExpression") ?: return "cron"
                cronWords[cron.trim()]?.let { "$cron · $it" } ?: cron
            }
            AgentTriggerType.WEBHOOK -> string("path")?.let(::webhookPath) ?: "webhook"
            AgentTriggerType.TICKET -> {
                val source = string("source")?.replaceFirstChar { it.titlecase() } ?: "Ticket"
                val labels = strings("labels")
                if (labels.isEmpty()) "$source · any label" else "$source · ${labels.joinToString(", ")}"
            }
            AgentTriggerType.GITHUB -> eventSummary(strings("events"), string("login")?.let { "@$it" }, strings("repos"))
            AgentTriggerType.LINEAR -> eventSummary(strings("events"), string("user"), strings("teams"))
            AgentTriggerType.SLACK -> {
                val parts = mutableListOf("#" + (string("channelId") ?: "channel"))
                if (config["mentionOnly"]?.boolValue == true) parts += "@-mentions only"
                string("keyword")?.let { parts += "“$it”" }
                if (config["includeThreads"]?.boolValue == true) parts += "with threads"
                parts.joinToString(" · ")
            }
            AgentTriggerType.MANUAL -> "By hand"
            null -> type
        }
    }

    /** "review requested, mentioned · @octocat · acme/web". */
    private fun eventSummary(
        events: List<String>,
        who: String?,
        scope: List<String>,
    ): String {
        val names = events.map { it.replace('_', ' ') }
        val parts = mutableListOf(if (names.isEmpty()) "any event" else names.joinToString(", "))
        who?.let { parts += it }
        if (scope.isNotEmpty()) parts += scope.joinToString(", ")
        return parts.joinToString(" · ")
    }
}

/**
 * The New trigger sheet's answers, one set per type so switching type and back keeps what was typed.
 * [validation] says why it can't be created (null = OK); [config] is the body's `config`.
 */
data class AgentTriggerDraft(
    val type: AgentTriggerType = AgentTriggerType.SCHEDULE,
    val cron: String = "0 9 * * 1-5",
    val webhookPath: String = AgentTriggers.randomWebhookPath(),
    val ticketSource: String = "github",
    val ticketLabels: List<String> = emptyList(),
    val githubEvents: List<String> = listOf("review_requested", "mentioned"),
    val githubLogin: String = "",
    val slackChannel: String = "",
    val slackKeyword: String = "",
    val slackMentionOnly: Boolean = false,
    val slackIncludeThreads: Boolean = false,
    val linearEvents: List<String> = listOf("assigned", "mentioned"),
    val linearUser: String = "",
) {
    private fun personal(events: List<String>, kinds: List<AgentEventKind>) = kinds.any { it.personal && it.value in events }

    /** Whether the picked GitHub / Linear events are "about someone" and so need a login / user. */
    val needsPerson: Boolean
        get() = when (type) {
            AgentTriggerType.GITHUB -> personal(githubEvents, AgentTriggers.githubKinds)
            AgentTriggerType.LINEAR -> personal(linearEvents, AgentTriggers.linearKinds)
            else -> false
        }

    /** Why this draft can't be saved yet, in the server's words where it has some; null when valid. */
    val validation: String?
        get() = when (type) {
            AgentTriggerType.SCHEDULE -> if (AgentTriggers.cronIsValid(cron)) null else "Expected five space-separated fields."
            AgentTriggerType.WEBHOOK -> when {
                webhookPath.isBlank() -> "Pick a path for the webhook."
                webhookPath.trim().any { it.isWhitespace() || it == '/' } -> "The path is one segment: no spaces or slashes."
                else -> null
            }
            AgentTriggerType.GITHUB ->
                if (needsPerson && githubLogin.trim().removePrefix("@").isEmpty()) {
                    "Add a GitHub username — review, mention and assign events are about someone."
                } else {
                    null
                }
            AgentTriggerType.LINEAR ->
                if (needsPerson && linearUser.trim().removePrefix("@").isEmpty()) {
                    "Add a Linear user — assign and mention events are about someone."
                } else {
                    null
                }
            AgentTriggerType.SLACK ->
                if (AgentTriggers.isSlackChannelId(slackChannel)) null else "Slack channel ids look like C0123ABCD."
            AgentTriggerType.TICKET, AgentTriggerType.MANUAL -> null
        }

    val isValid: Boolean
        get() = validation == null

    /** The `config` object for `POST …/triggers` (`schemas/trigger.ts` `TriggerConfigSchema`). */
    fun config(): JsonObject {
        val out = linkedMapOf<String, JsonElement>()
        fun strings(values: List<String>) = JsonArray(values.map(::JsonPrimitive))
        when (type) {
            AgentTriggerType.SCHEDULE -> out["cronExpression"] = JsonPrimitive(cron.trim())
            AgentTriggerType.WEBHOOK -> out["path"] = JsonPrimitive(webhookPath.trim())
            AgentTriggerType.TICKET -> {
                out["source"] = JsonPrimitive(ticketSource)
                if (ticketLabels.isNotEmpty()) out["labels"] = strings(ticketLabels)
            }
            AgentTriggerType.GITHUB -> {
                out["events"] = strings(githubEvents)
                githubLogin.trim().removePrefix("@").takeIf { it.isNotEmpty() }?.let { out["login"] = JsonPrimitive(it) }
            }
            AgentTriggerType.SLACK -> {
                out["channelId"] = JsonPrimitive(slackChannel.trim())
                out["mentionOnly"] = JsonPrimitive(slackMentionOnly)
                slackKeyword.trim().takeIf { it.isNotEmpty() }?.let { out["keyword"] = JsonPrimitive(it) }
                if (slackIncludeThreads) out["includeThreads"] = JsonPrimitive(true)
            }
            AgentTriggerType.LINEAR -> {
                out["events"] = strings(linearEvents)
                linearUser.trim().removePrefix("@").takeIf { it.isNotEmpty() }?.let { out["user"] = JsonPrimitive(it) }
            }
            AgentTriggerType.MANUAL -> Unit
        }
        return JsonObject(out)
    }

    /** The request body for this draft. */
    fun input(): PersistentAgentTriggerInput = PersistentAgentTriggerInput(type = type.raw, config = config(), enabled = true)

    /** The sheet's footer for the picked type (iOS `WhenSection` footers, worded for an agent). */
    val footer: String
        get() = when (type) {
            AgentTriggerType.SCHEDULE -> when {
                !AgentTriggers.cronIsValid(cron) -> "Expected five space-separated fields."
                else -> AgentTriggers.cronWords[cron.trim()]?.let { "Wakes the agent $it." } ?: "Five-field cron expression, in UTC."
            }
            AgentTriggerType.WEBHOOK -> "POST to this path to wake the agent. The path must be unique across the workspace."
            AgentTriggerType.TICKET -> "Only tickets with at least one matching label wake the agent. No labels matches every ticket from the source."
            AgentTriggerType.GITHUB, AgentTriggerType.SLACK, AgentTriggerType.LINEAR ->
                "Each matching event wakes the agent, with the event in its inbox as a message."
            AgentTriggerType.MANUAL -> "Fires only when someone runs it by hand. Messages always wake the agent."
        }
}
