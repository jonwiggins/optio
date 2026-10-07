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
        assertEquals(
            "Incident triggered, Incident resolved · high urgency · P1 pager",
            row("pagerduty", mapOf("events" to listOf("incident.triggered", "incident.resolved"), "urgency" to "high", "services" to listOf("P1 pager"))).summary,
        )
        assertEquals("Any PagerDuty incident event", row("pagerduty", emptyMap()).summary)
        assertEquals("issue.created, issue.updated", row("pylon", mapOf("events" to listOf("issue.created", "issue.updated"))).summary)
        assertEquals("Any Pylon event", row("pylon", emptyMap()).summary)
        assertEquals("PagerDuty", row("pagerduty", emptyMap()).label)
        assertEquals("Pylon", row("pylon", emptyMap()).label)
        assertEquals(
            "A branch is pushed, A workflow run fails · main, release/* · CI",
            row("github", mapOf("events" to listOf("push", "workflow_failed"), "branches" to listOf("main", "release/*"), "workflows" to listOf("CI"))).summary,
        )
        assertEquals(
            "Review requested from me, A pipeline fails · @jane · acme/app",
            row("gitlab", mapOf("events" to listOf("review_requested", "pipeline_failed"), "username" to "jane", "projects" to listOf("acme/app"))).summary,
        )
        assertEquals("Any GitLab event", row("gitlab", emptyMap()).summary)
        assertEquals("Status changes · ENG · → Done", row("jira", mapOf("events" to listOf("transitioned"), "projects" to listOf("ENG"), "statuses" to listOf("Done"))).summary)
        assertEquals("New issue, Issue regressed · web · production", row("sentry", mapOf("events" to listOf("issue_created", "issue_unresolved"), "projects" to listOf("web"), "environments" to listOf("production"))).summary)
        assertEquals("Alerts firing · critical", row("alertmanager", mapOf("events" to listOf("firing"), "severities" to listOf("critical"))).summary)
        assertEquals("Any alert group", row("alertmanager", emptyMap()).summary)
        assertEquals("Monitor triggered · P1 · env:prod", row("datadog", mapOf("events" to listOf("triggered"), "priorities" to listOf("P1"), "tags" to listOf("env:prod"))).summary)
        assertEquals("GitLab", row("gitlab", emptyMap()).label)
        assertEquals("Jira", row("jira", emptyMap()).label)
        assertEquals("Sentry", row("sentry", emptyMap()).label)
        assertEquals("Alertmanager", row("alertmanager", emptyMap()).label)
        assertEquals("Datadog", row("datadog", emptyMap()).label)
        assertEquals("GitLab tickets", row("ticket", mapOf("source" to "gitlab")).summary)
        assertTrue("gitlab" in TriggerText.ticketSources)
        assertEquals("Custom", row("custom", emptyMap()).label)
        assertEquals("GitHub", row("github", emptyMap()).label)
    }

    @Test
    fun humanizedHeaderPhrases() {
        assertEquals("Webhook", ScheduleFormat.humanize(row("webhook", mapOf("path" to "x"))))
        assertEquals("GitHub tickets · bug", ScheduleFormat.humanize(row("ticket", mapOf("labels" to listOf("bug")))))
        assertEquals("Manual", ScheduleFormat.humanize(row("manual", emptyMap())))
        assertEquals("Slack messages", ScheduleFormat.humanize(row("slack", mapOf("channelId" to "C0123ABCD"))))
        assertEquals("GitLab events", ScheduleFormat.humanize(row("gitlab", emptyMap())))
        assertEquals("Jira events", ScheduleFormat.humanize(row("jira", emptyMap())))
        assertEquals("Sentry alerts", ScheduleFormat.humanize(row("sentry", emptyMap())))
        assertEquals("Alertmanager alerts", ScheduleFormat.humanize(row("alertmanager", emptyMap())))
        assertEquals("Datadog monitors", ScheduleFormat.humanize(row("datadog", emptyMap())))
    }

    /** Pylon, Alertmanager and Datadog listen at their own URL and carry their own secret. */
    @Test
    fun selfSecretTriggersHaveTheirOwnUrl() {
        assertEquals("http://api/api/hooks/datadog/t1", row("datadog", emptyMap()).selfSecretUrl("http://api/"))
        assertEquals("http://api/api/hooks/alertmanager/t1", row("alertmanager", emptyMap()).selfSecretUrl("http://api"))
        assertEquals("/api/hooks/pylon/t1", row("pylon", emptyMap()).selfSecretUrl(null))
        assertNull(row("sentry", emptyMap()).selfSecretUrl("http://api"))
        assertTrue(TriggerKind.DATADOG.selfSecret && TriggerKind.ALERTMANAGER.selfSecret && TriggerKind.PYLON.selfSecret)
        assertFalse(TriggerKind.SENTRY.selfSecret)
        assertTrue(row("pylon", mapOf("hasSecret" to true)).hasSecret)
        assertFalse(row("pylon", emptyMap()).hasSecret)
        assertNotNull(TriggerText.selfSecretHint(TriggerKind.DATADOG))
        assertNull(TriggerText.selfSecretHint(TriggerKind.SENTRY))
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

        // PagerDuty needs at least one incident event (its default has one); Pylon's events are optional.
        val pagerduty = TriggerDraft.new(TriggerKind.PAGERDUTY)
        assertEquals(listOf("incident.triggered"), pagerduty.events)
        assertNull(pagerduty.problem)
        assertNotNull(pagerduty.toggleEvent("incident.triggered", false).problem)
        assertFalse(pagerduty.needsPerson)
        val pylon = TriggerDraft.new(TriggerKind.PYLON)
        assertNull(pylon.problem)
        assertTrue(pylon.events.isEmpty())
        assertEquals(TriggerKind.PAGERDUTY, TriggerKind.fromRaw("pagerduty"))
        assertEquals(
            listOf(TriggerKind.GITHUB, TriggerKind.GITLAB, TriggerKind.SLACK, TriggerKind.LINEAR, TriggerKind.JIRA, TriggerKind.PYLON, TriggerKind.PAGERDUTY, TriggerKind.SENTRY, TriggerKind.ALERTMANAGER, TriggerKind.DATADOG),
            TriggerKind.editable.takeLast(10),
        )

        // GitLab mirrors GitHub (username); Jira mirrors Linear (user).
        val gitlab = TriggerDraft.new(TriggerKind.GITLAB)
        assertTrue(gitlab.needsPerson)
        assertNotNull(gitlab.problem)
        assertNull(gitlab.withString("username", "jane").problem)
        assertNull(gitlab.toggleEvent("pipeline_failed", true).problem)
        assertNotNull(gitlab.toggleEvent("assigned", true).problem)
        assertEquals("username", gitlab.personKey)
        val jira = TriggerDraft.new(TriggerKind.JIRA).toggleEvent("transitioned", true)
        assertNull(jira.problem)
        assertNotNull(jira.toggleEvent("mentioned", true).problem)
        assertNull(jira.toggleEvent("mentioned", true).withString("user", "5b10ac8d").problem)
        assertEquals("user", jira.personKey)

        // Sentry / Alertmanager / Datadog need at least one event (their defaults have one) and no person.
        for (kind in listOf(TriggerKind.SENTRY, TriggerKind.ALERTMANAGER, TriggerKind.DATADOG)) {
            val draft = TriggerDraft.new(kind)
            assertEquals(1, draft.events.size, kind.name)
            assertNull(draft.problem, kind.name)
            assertNotNull(draft.toggleEvent(draft.events.first(), false).problem, kind.name)
            assertFalse(draft.needsPerson, kind.name)
            assertTrue(draft.eventKinds.none { it.personal }, kind.name)
        }
        assertEquals(listOf("issue_created"), TriggerDraft.new(TriggerKind.SENTRY).events)
        assertEquals(listOf("firing"), TriggerDraft.new(TriggerKind.ALERTMANAGER).events)
        assertEquals(listOf("triggered"), TriggerDraft.new(TriggerKind.DATADOG).events)
        assertTrue(TriggerText.githubKinds.any { it.value == "workflow_failed" && !it.personal })
    }

    @Test
    fun submitConfigTrimsAndDropsEmptyValues() {
        val ticket = TriggerDraft.new(TriggerKind.TICKET).withStrings("labels", emptyList())
        assertEquals(JsonObject(mapOf("source" to JsonPrimitive("github"))), ticket.submitConfig())

        val github = TriggerDraft.new(TriggerKind.GITHUB).withString("login", " @octocat ").withStrings("repos", emptyList()).withStrings("events", emptyList())
        assertEquals(JsonObject(mapOf("login" to JsonPrimitive("octocat"))), github.submitConfig())

        val gitlab = TriggerDraft.new(TriggerKind.GITLAB).withString("username", "@jane").withStrings("projects", emptyList()).withStrings("branches", listOf("main"))
        assertEquals(JsonObject(mapOf("username" to JsonPrimitive("jane"), "branches" to JsonArray(listOf(JsonPrimitive("main"))))), gitlab.submitConfig())

        val datadog = TriggerDraft.new(TriggerKind.DATADOG).withStrings("priorities", emptyList()).withStrings("tags", emptyList())
        assertEquals(JsonObject(mapOf("events" to JsonArray(listOf(JsonPrimitive("triggered"))))), datadog.submitConfig())

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
