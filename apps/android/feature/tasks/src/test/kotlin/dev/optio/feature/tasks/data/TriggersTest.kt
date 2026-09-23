package dev.optio.feature.tasks.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The trigger editor's model: types, defaults, the server's validation rules, and the save diff. */
class TriggersTest {
    private fun row(type: String, config: Map<String, Any>, enabled: Boolean = true) = TriggerRow(
        id = "t1",
        type = type,
        enabled = enabled,
        config = config.mapValues { (_, v) ->
            when (v) {
                is String -> JsonPrimitive(v)
                is Boolean -> JsonPrimitive(v)
                is List<*> -> JsonArray(v.map { JsonPrimitive(it as String) })
                else -> error("unsupported")
            }
        },
    )

    @Test
    fun cronValidityAndHints() {
        assertTrue(TriggerText.cronIsValid("0 9 * * 1-5"))
        assertTrue(TriggerText.cronIsValid("  0  9 * *   1 "))
        assertFalse(TriggerText.cronIsValid("0 9 * *"))
        assertFalse(TriggerText.cronIsValid(""))
        assertFalse(TriggerText.cronIsValid(null))
        assertEquals("Runs weekdays at 09:00 UTC.", TriggerText.cronHint("0 9 * * 1-5"))
        assertEquals("Runs every hour.", TriggerText.cronHint(" 0 * * * * "))
        assertEquals("Five-field cron expression, in UTC.", TriggerText.cronHint("15 3 * * *"))
        assertEquals("Expected five space-separated fields.", TriggerText.cronHint("0 9"))
    }

    @Test
    fun webhookUrlsAndPaths() {
        assertEquals("http://10.0.2.2:4964/api/hooks/nightly", TriggerText.hookUrl("http://10.0.2.2:4964/", "nightly"))
        assertEquals("/api/hooks/nightly", TriggerText.hookUrl(null, "nightly"))
        assertEquals("my-hook_1", TriggerText.sanitizePath("my-hook/_1 !"))
        assertTrue(TriggerText.newWebhookPath().matches(Regex("hook-[0-9a-f]{8}")))
    }

    @Test
    fun summariesForEveryType() {
        assertEquals("Every Monday 09:00 · 0 9 * * 1", row("schedule", mapOf("cronExpression" to "0 9 * * 1")).summary)
        assertEquals("15 3 1 * *", row("schedule", mapOf("cronExpression" to "15 3 1 * *")).summary)
        assertEquals("/api/hooks/nightly", row("webhook", mapOf("path" to "nightly")).summary)
        assertEquals("GitHub tickets", row("ticket", mapOf("source" to "github")).summary)
        assertEquals("Linear tickets · bug, p1", row("ticket", mapOf("source" to "linear", "labels" to listOf("bug", "p1"))).summary)
        assertEquals(
            "Review requested from me, Any PR opened · @octocat · acme/web",
            row("github", mapOf("events" to listOf("review_requested", "pr_opened"), "login" to "octocat", "repos" to listOf("acme/web"))).summary,
        )
        assertEquals("Any GitHub event · @octocat", row("github", mapOf("login" to "octocat")).summary)
        assertEquals("#C0123ABCD · @-mentions only · “deploy”", row("slack", mapOf("channelId" to "C0123ABCD", "mentionOnly" to true, "keyword" to "deploy")).summary)
        assertEquals("Assigned to me · Jane Doe · ENG", row("linear", mapOf("events" to listOf("assigned"), "user" to "Jane Doe", "teams" to listOf("ENG"))).summary)
        assertEquals("Runs when started by hand", row("manual", emptyMap()).summary)
        assertEquals("Custom", row("custom", emptyMap()).label)
        assertEquals("GitHub", row("github", emptyMap()).label)
    }

    @Test
    fun humanizedHeaderPhrases() {
        assertEquals("Webhook", ScheduleFormat.humanize(row("webhook", mapOf("path" to "x"))))
        assertEquals("GitHub tickets · bug", ScheduleFormat.humanize(row("ticket", mapOf("labels" to listOf("bug")))))
        assertEquals("Manual", ScheduleFormat.humanize(row("manual", emptyMap())))
        assertEquals("Slack messages", ScheduleFormat.humanize(row("slack", mapOf("channelId" to "C0123ABCD"))))
    }

    @Test
    fun newDraftsStartWithTheTypesDefaults() {
        assertEquals("0 9 * * *", TriggerDraft.new(TriggerKind.SCHEDULE).cron)
        assertTrue(TriggerDraft.new(TriggerKind.WEBHOOK).path.startsWith("hook-"))
        assertEquals("github", TriggerDraft.new(TriggerKind.TICKET).ticketSource)
        assertEquals(TriggerDraft.Change.CREATE, TriggerDraft.new().change)
        assertEquals(TriggerDraft.Change.NONE, TriggerDraft.new().copy(deleted = true).change)
    }

    @Test
    fun validationMirrorsTheServer() {
        assertNull(TriggerDraft.new(TriggerKind.MANUAL).problem)
        assertNotNull(TriggerDraft.new(TriggerKind.SCHEDULE).withString("cronExpression", "0 9").problem)
        assertNotNull(TriggerDraft.new(TriggerKind.WEBHOOK).withString("path", "").problem)

        // GitHub: no events (= any) or a personal event needs a login; public events don't.
        val github = TriggerDraft.new(TriggerKind.GITHUB)
        assertTrue(github.needsPerson)
        assertNotNull(github.problem)
        assertNull(github.withString("login", "octocat").problem)
        val prOnly = github.toggleEvent("pr_opened", true)
        assertFalse(prOnly.needsPerson)
        assertNull(prOnly.problem)
        assertNotNull(prOnly.toggleEvent("mentioned", true).problem)

        // Slack needs a channel id shaped like C0123ABCD.
        assertNotNull(TriggerDraft.new(TriggerKind.SLACK).problem)
        assertNotNull(TriggerDraft.new(TriggerKind.SLACK).withString("channelId", "general").problem)
        assertNull(TriggerDraft.new(TriggerKind.SLACK).withString("channelId", "C0123ABCD").problem)

        // Linear: assigned / mentioned need a user.
        val linear = TriggerDraft.new(TriggerKind.LINEAR).toggleEvent("created", true)
        assertNull(linear.problem)
        assertNotNull(linear.toggleEvent("assigned", true).problem)
        assertNull(linear.toggleEvent("assigned", true).withString("user", "Jane").problem)
    }

    @Test
    fun submitConfigTrimsAndDropsEmptyValues() {
        val ticket = TriggerDraft.new(TriggerKind.TICKET).withStrings("labels", emptyList())
        assertEquals(JsonObject(mapOf("source" to JsonPrimitive("github"))), ticket.submitConfig())

        val github = TriggerDraft.new(TriggerKind.GITHUB).withString("login", " @octocat ").withStrings("repos", emptyList()).withStrings("events", emptyList())
        assertEquals(JsonObject(mapOf("login" to JsonPrimitive("octocat"))), github.submitConfig())

        val webhook = TriggerDraft.new(TriggerKind.WEBHOOK).withString("path", "nightly").withString("secret", "")
        assertEquals(JsonObject(mapOf("path" to JsonPrimitive("nightly"))), webhook.submitConfig())

        val schedule = TriggerDraft.new(TriggerKind.SCHEDULE).withString("cronExpression", " 0 9 * * 1 ")
        assertEquals(JsonPrimitive("0 9 * * 1"), schedule.submitConfig()["cronExpression"])
    }

    @Test
    fun anEditKeepsConfigKeysTheEditorDoesntShow() {
        val saved = row("slack", mapOf("channelId" to "C0123ABCD", "customKey" to "kept"))
        val draft = TriggerDraft.of(saved).withBool("mentionOnly", true)
        assertEquals(JsonPrimitive("kept"), draft.submitConfig()["customKey"])
        assertEquals(TriggerDraft.Change.UPDATE, draft.change)
    }

    @Test
    fun theSaveDiff() {
        val saved = TriggerDraft.of(row("schedule", mapOf("cronExpression" to "0 9 * * 1")))
        assertEquals(TriggerDraft.Change.NONE, saved.change)
        assertEquals(TriggerDraft.Change.UPDATE, saved.withString("cronExpression", "0 10 * * 1").change)
        assertEquals(TriggerDraft.Change.UPDATE, saved.copy(enabled = false).change)
        assertEquals(TriggerDraft.Change.DELETE, saved.copy(deleted = true).change)
        // The PATCH body has no type: a type change is delete + create.
        assertEquals(TriggerDraft.Change.REPLACE, saved.withType(TriggerKind.WEBHOOK).change)
        // Switching back restores the saved config.
        val back = saved.withType(TriggerKind.WEBHOOK).withType(TriggerKind.SCHEDULE)
        assertEquals("0 9 * * 1", back.cron)
        assertEquals(TriggerDraft.Change.NONE, back.change)
    }
}
