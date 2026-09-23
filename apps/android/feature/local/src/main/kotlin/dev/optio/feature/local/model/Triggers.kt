package dev.optio.feature.local.model

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.ConfirmationNumber
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material.icons.outlined.Webhook
import androidx.compose.ui.graphics.vector.ImageVector
import dev.optio.core.model.arrayValue
import dev.optio.core.model.boolValue
import dev.optio.core.model.stringValue
import dev.optio.feature.local.api.LocalTrigger
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The kinds of trigger a Local automation takes (the web's `TRIGGER_META` in
 * `automations-section.tsx`; iOS offers the first three). `manual` rows exist on the server but are
 * not created from here.
 */
enum class TriggerKind(val raw: String, val label: String) {
    SCHEDULE("schedule", "Schedule"),
    WEBHOOK("webhook", "Webhook"),
    TICKET("ticket", "Ticket sync"),
    GITHUB("github", "GitHub"),
    SLACK("slack", "Slack"),
    LINEAR("linear", "Linear"),
    ;

    val icon: ImageVector
        get() =
            when (this) {
                SCHEDULE -> Icons.Outlined.Schedule
                WEBHOOK -> Icons.Outlined.Webhook
                TICKET -> Icons.Outlined.ConfirmationNumber
                GITHUB -> Icons.Outlined.Code
                SLACK -> Icons.Outlined.Tag
                LINEAR -> Icons.Outlined.Bolt
            }

    companion object {
        fun of(raw: String): TriggerKind? = entries.firstOrNull { it.raw == raw }
    }
}

/** One choosable event of a GitHub / Linear trigger; [personal] ones need your login / user. */
data class EventKind(val value: String, val label: String, val personal: Boolean)

object Triggers {
    val ticketSources: List<String> = listOf("github", "gitlab", "linear", "jira", "notion")

    val githubKinds: List<EventKind> =
        listOf(
            EventKind("review_requested", "Review requested from me", true),
            EventKind("mentioned", "I'm @-mentioned", true),
            EventKind("assigned", "Assigned to me", true),
            EventKind("pr_opened", "Any PR opened", false),
            EventKind("issue_opened", "Any issue opened", false),
        )

    val linearKinds: List<EventKind> =
        listOf(
            EventKind("assigned", "Assigned to me", true),
            EventKind("mentioned", "I'm @-mentioned", true),
            EventKind("created", "Any issue created", false),
            EventKind("labeled", "A label is added", false),
        )

    fun label(trigger: LocalTrigger): String = TriggerKind.of(trigger.type)?.label ?: trigger.type.replaceFirstChar { it.uppercase() }

    fun icon(trigger: LocalTrigger): ImageVector = TriggerKind.of(trigger.type)?.icon ?: Icons.Outlined.PlayArrow

    /** One line describing what fires it (the web's `triggerSummary`). */
    fun summary(trigger: LocalTrigger): String = summary(trigger.type, trigger.config)

    fun summary(
        type: String,
        config: JsonObject?,
    ): String {
        val c = config ?: JsonObject(emptyMap())
        fun str(key: String): String? = c[key]?.stringValue?.takeIf { it.isNotBlank() }
        fun list(key: String): List<String> = c[key]?.arrayValue?.mapNotNull { it.stringValue } ?: emptyList()
        return when (type) {
            "schedule" -> str("cronExpression").orEmpty()
            "webhook" -> "POST /api/hooks/${str("path").orEmpty()}"
            "ticket" -> {
                val labels = list("labels")
                (str("source") ?: "any source") + if (labels.isNotEmpty()) " · ${labels.joinToString(", ")}" else ""
            }
            "github" -> {
                val events = list("events").ifEmpty { listOf("any") }.joinToString(", ")
                val repos = list("repos")
                events + (str("login")?.let { " → @$it" } ?: "") + if (repos.isNotEmpty()) " in ${repos.joinToString(", ")}" else ""
            }
            "slack" ->
                (str("channelId") ?: "?") +
                    (if (c["mentionOnly"]?.boolValue == true) " (@-mentions)" else "") +
                    (str("keyword")?.let { " · \"$it\"" } ?: "")
            "linear" -> {
                val events = list("events").ifEmpty { listOf("any") }.joinToString(", ")
                val teams = list("teams")
                events + (str("user")?.let { " → $it" } ?: "") + if (teams.isNotEmpty()) " in ${teams.joinToString(", ")}" else ""
            }
            else -> ""
        }
    }

    /** Splits a comma-separated field ("ENG, OPS") into its trimmed, non-empty parts. */
    fun list(text: String): List<String> = text.split(',').map { it.trim() }.filter { it.isNotEmpty() }

    /** What the Add trigger form collected, before validation. */
    data class Draft(
        val kind: TriggerKind = TriggerKind.SCHEDULE,
        val cron: String = "0 9 * * 1-5",
        val path: String = "",
        val source: String = "github",
        val labels: String = "",
        val githubEvents: Set<String> = setOf("review_requested"),
        val githubLogin: String = "",
        val githubRepos: String = "",
        val channelId: String = "",
        val keyword: String = "",
        val mentionOnly: Boolean = false,
        val includeThreads: Boolean = false,
        val linearEvents: Set<String> = setOf("assigned"),
        val linearUser: String = "",
        val linearTeams: String = "",
    )

    /** The config the server takes for [draft], or the problem to show (the web's `build()`). */
    fun build(draft: Draft): Result<JsonObject> {
        val out = LinkedHashMap<String, JsonElement>()
        fun strings(values: Collection<String>) = JsonArray(values.map(::JsonPrimitive))
        when (draft.kind) {
            TriggerKind.SCHEDULE -> {
                val cron = draft.cron.trim()
                if (cron.split(Regex("\\s+")).size != 5) return fail("Cron expression needs five space-separated fields")
                out["cronExpression"] = JsonPrimitive(cron)
            }
            TriggerKind.WEBHOOK -> {
                val path = draft.path.trim()
                if (path.isEmpty()) return fail("Webhook path is required")
                out["path"] = JsonPrimitive(path)
            }
            TriggerKind.TICKET -> {
                out["source"] = JsonPrimitive(draft.source)
                val labels = list(draft.labels)
                if (labels.isNotEmpty()) out["labels"] = strings(labels)
            }
            TriggerKind.GITHUB -> {
                if (draft.githubEvents.isEmpty()) return fail("Pick at least one GitHub event")
                val login = draft.githubLogin.trim().removePrefix("@")
                val personal = draft.githubEvents.any { e -> githubKinds.firstOrNull { it.value == e }?.personal == true }
                if (personal && login.isEmpty()) return fail("Your GitHub username is required for those events")
                // Keep the menu's order so the summary reads the same everywhere.
                out["events"] = strings(githubKinds.map { it.value }.filter { it in draft.githubEvents })
                if (login.isNotEmpty()) out["login"] = JsonPrimitive(login)
                val repos = list(draft.githubRepos)
                if (repos.isNotEmpty()) out["repos"] = strings(repos)
            }
            TriggerKind.SLACK -> {
                val channel = draft.channelId.trim()
                if (!Regex("^[A-Z][A-Z0-9]{5,}$").matches(channel)) {
                    return fail("Slack channel id looks wrong — it's the C0123… id from the channel details")
                }
                out["channelId"] = JsonPrimitive(channel)
                draft.keyword.trim().takeIf { it.isNotEmpty() }?.let { out["keyword"] = JsonPrimitive(it) }
                if (draft.mentionOnly) out["mentionOnly"] = JsonPrimitive(true)
                if (draft.includeThreads) out["includeThreads"] = JsonPrimitive(true)
            }
            TriggerKind.LINEAR -> {
                if (draft.linearEvents.isEmpty()) return fail("Pick at least one Linear event")
                val user = draft.linearUser.trim().removePrefix("@")
                val personal = draft.linearEvents.any { e -> linearKinds.firstOrNull { it.value == e }?.personal == true }
                if (personal && user.isEmpty()) return fail("Your Linear name or user id is required for those events")
                out["events"] = strings(linearKinds.map { it.value }.filter { it in draft.linearEvents })
                if (user.isNotEmpty()) out["user"] = JsonPrimitive(user)
                val labels = list(draft.labels)
                if (labels.isNotEmpty()) out["labels"] = strings(labels)
                val teams = list(draft.linearTeams)
                if (teams.isNotEmpty()) out["teams"] = strings(teams)
            }
        }
        return Result.success(JsonObject(out))
    }

    private fun fail(message: String): Result<JsonObject> = Result.failure(IllegalArgumentException(message))
}
