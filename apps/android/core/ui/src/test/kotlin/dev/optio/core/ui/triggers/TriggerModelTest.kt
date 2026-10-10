package dev.optio.core.ui.triggers

import kotlin.random.Random
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Test

/**
 * The one trigger model every form shares: the server's validation rules, the `config` shapes it
 * accepts, and the summaries every trigger row shows.
 */
class TriggerModelTest {
    private fun config(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    private fun event(type: WhenType, vararg fields: Pair<String, kotlinx.serialization.json.JsonElement>) =
        TriggerDraft.of(type).let { it.copy(event = it.event.copy(config = jsonObjectOf(*fields))) }

    @Test
    fun everyTriggerTypeIsAWhen() {
        assertEquals(14, WhenType.entries.size)
        assertEquals(TriggerType.entries.map { it.raw }, WhenType.entries.filter { !it.isEvent }.map { it.raw })
        assertEquals(EventTriggerType.entries.map { it.raw }, WhenType.entries.filter { it.isEvent }.map { it.raw })
        assertEquals(WhenType.entries - WhenType.MANUAL, WhenType.forSheet())
        assertEquals(listOf(WhenType.PYLON, WhenType.ALERTMANAGER, WhenType.DATADOG), WhenType.entries.filter { it.event?.selfSecret == true })
        assertEquals("Manual", WhenType.MANUAL.typeLabel)
        assertEquals("Now", WhenType.MANUAL.label)
    }

    @Test
    fun cronNeedsFiveFields() {
        assertTrue(cronIsValid("0 9 * * 1-5"))
        assertTrue(cronIsValid("  */5   * * * *  "))
        assertFalse(cronIsValid("0 9 * *"))
        assertFalse(cronIsValid("0 9 * * * *"))
        assertFalse(cronIsValid(""))
        assertFalse(cronIsValid(null))
    }

    @Test
    fun randomWebhookPathsLookLikeTheWebs() {
        val path = randomWebhookPath(Random(7))
        assertTrue(Regex("^hook-[a-z0-9]{8}$").matches(path), path)
    }

    @Test
    fun pickingATypeFillsItsDefaultsOnceAndKeepsWhatWasTyped() {
        val schedule = TriggerDraft().select(WhenType.SCHEDULE)
        assertEquals("0 9 * * *", schedule.trigger.cronExpression)
        val typed = schedule.copy(trigger = schedule.trigger.copy(cronExpression = "0 * * * *")).select(WhenType.WEBHOOK)
        assertTrue(typed.trigger.webhookPath!!.startsWith("hook-"))
        assertEquals("0 * * * *", typed.select(WhenType.SCHEDULE).trigger.cronExpression, "switching back keeps the answer")
        val github = typed.select(WhenType.GITHUB)
        assertEquals(EventTriggerType.GITHUB, github.event.type)
        assertEquals(listOf("review_requested", "mentioned"), eventsOf(github.event.config))
        assertEquals(TriggerType.MANUAL, github.trigger.type, "an event carries no plain trigger")
    }

    @Test
    fun scheduleDraft() {
        val draft = TriggerDraft(WhenType.SCHEDULE, TriggerConfig(TriggerType.SCHEDULE, cronExpression = " 0 9 * * 1 "))
        assertNull(draft.problem)
        assertEquals(TriggerSpec("schedule", config("""{"cronExpression":"0 9 * * 1"}""")), draft.spec())
        assertEquals("Wakes the agent Mondays at 09:00 UTC.", draft.footer("wakes the agent"))
        assertEquals("Five-field cron expression, in UTC.", draft.copy(trigger = draft.trigger.copy(cronExpression = "15 3 * * *")).footer())
        assertEquals("Expected five space-separated fields.", draft.copy(trigger = draft.trigger.copy(cronExpression = "15 3")).problem)
    }

    @Test
    fun webhookDraft() {
        val draft = TriggerDraft(WhenType.WEBHOOK, TriggerConfig(TriggerType.WEBHOOK, webhookPath = "release-hook"))
        assertNull(draft.problem)
        assertEquals(TriggerSpec("webhook", config("""{"path":"release-hook"}""")), draft.spec())
        assertEquals(TriggerGap.WEBHOOK, draft.copy(trigger = draft.trigger.copy(webhookPath = " ")).gaps.single())
        assertEquals(TriggerGap.WEBHOOK, draft.copy(trigger = draft.trigger.copy(webhookPath = "a/b")).gaps.single())
        assertEquals("/api/hooks/release-hook", webhookPath("release-hook"))
        assertEquals("/api/hooks/datadog/tr-1", selfSecretPath(EventTriggerType.DATADOG, "tr-1"))
    }

    @Test
    fun ticketDraft() {
        val draft = TriggerDraft.of(WhenType.TICKET)
        assertEquals(config("""{"source":"github"}"""), draft.spec()!!.config)
        val labelled = draft.copy(trigger = draft.trigger.copy(ticketSource = TicketSource.LINEAR, ticketLabels = listOf("docs", "cleanup")))
        assertEquals(config("""{"source":"linear","labels":["docs","cleanup"]}"""), labelled.spec()!!.config)
        assertNull(labelled.problem)
    }

    @Test
    fun githubDraftNeedsALoginForPersonalEvents() {
        val draft = TriggerDraft.of(WhenType.GITHUB)
        assertEquals(listOf(TriggerGap.IDENTITY), draft.gaps)
        assertEquals("Add your username — review, mention and assign events are about someone.", draft.problem)
        val withLogin = event(WhenType.GITHUB, "events" to jsonArrayOf("review_requested", "mentioned"), "login" to JsonPrimitive("octocat"))
        assertNull(withLogin.problem)
        assertEquals(config("""{"events":["review_requested","mentioned"],"login":"octocat"}"""), withLogin.spec()!!.config)
        // Only "any PR / issue" kinds: nobody to name.
        val anyPr = event(WhenType.GITHUB, "events" to jsonArrayOf("pr_opened", "issue_opened"))
        assertNull(anyPr.problem)
        // No kinds at all would mean "every kind" to the matcher: make it a choice.
        assertEquals(listOf(TriggerGap.EVENTS), event(WhenType.GITHUB, "events" to jsonArrayOf()).gaps)
    }

    @Test
    fun theOtherSourcesFollowTheSameRules() {
        assertEquals(listOf(TriggerGap.IDENTITY), TriggerDraft.of(WhenType.GITLAB).gaps)
        assertEquals(listOf(TriggerGap.IDENTITY), TriggerDraft.of(WhenType.JIRA).gaps)
        assertEquals(listOf(TriggerGap.IDENTITY), TriggerDraft.of(WhenType.LINEAR).gaps)
        assertNull(event(WhenType.GITLAB, "events" to jsonArrayOf("assigned"), "username" to JsonPrimitive("jane")).problem)
        // Linear's "only tickets from someone else" needs to know you.
        assertEquals(listOf(TriggerGap.IDENTITY), event(WhenType.LINEAR, "events" to jsonArrayOf("created"), "othersOnly" to JsonPrimitive(true)).gaps)
        for (type in listOf(WhenType.PAGERDUTY, WhenType.SENTRY, WhenType.ALERTMANAGER, WhenType.DATADOG)) {
            assertNull(TriggerDraft.of(type).problem, type.name)
            assertEquals(listOf(TriggerGap.EVENTS), event(type, "events" to jsonArrayOf()).gaps, type.name)
        }
        // Pylon's kinds are free text and optional.
        assertNull(TriggerDraft.of(WhenType.PYLON).problem)
        assertNull(event(WhenType.PYLON, "events" to jsonArrayOf()).problem)
    }

    @Test
    fun slackDraftNeedsAChannelId() {
        val draft = TriggerDraft.of(WhenType.SLACK)
        assertEquals("Slack channel ids look like C0123ABCD.", draft.problem)
        assertEquals(listOf(TriggerGap.CHANNEL), event(WhenType.SLACK, "channelId" to JsonPrimitive("general")).gaps)
        val ok = event(WhenType.SLACK, "channelId" to JsonPrimitive("C0123ABCD"), "mentionOnly" to JsonPrimitive(true), "keyword" to JsonPrimitive("docs"))
        assertNull(ok.problem)
        assertEquals(config("""{"channelId":"C0123ABCD","mentionOnly":true,"keyword":"docs"}"""), ok.spec()!!.config)
    }

    @Test
    fun manualDraftHasNoRowToAttach() {
        val draft = TriggerDraft(WhenType.MANUAL)
        assertNull(draft.problem)
        assertNull(draft.spec())
        assertEquals(TriggerSpec("manual", JsonObject(emptyMap())), draft.specOrManual())
        assertEquals(config("""{"type":"manual","config":{},"enabled":true}"""), draft.specOrManual().body)
    }

    @Test
    fun aStoredRowComesBackAsADraft() {
        val schedule = TriggerDraft.fromRow("schedule", config("""{"cronExpression":"0 8 * * *"}"""))
        assertEquals(WhenType.SCHEDULE, schedule.whenType)
        assertEquals("0 8 * * *", schedule.trigger.cronExpression)
        val ticket = TriggerDraft.fromRow("ticket", config("""{"source":"jira","labels":["bug"]}"""))
        assertEquals(TicketSource.JIRA, ticket.trigger.ticketSource)
        assertEquals(listOf("bug"), ticket.trigger.ticketLabels)
        val datadog = TriggerDraft.fromRow("datadog", config("""{"events":["recovered"],"tags":["env:prod"]}"""))
        assertEquals(WhenType.DATADOG, datadog.whenType)
        assertEquals(listOf("env:prod"), datadog.event.config.strings("tags"))
        assertEquals(WhenType.MANUAL, TriggerDraft.fromRow("carrier-pigeon", null).whenType)
    }

    @Test
    fun summariesOfEveryType() {
        assertEquals("cron", triggerSummary("schedule", null))
        assertEquals("0 9 * * 1-5 · weekdays at 09:00 UTC", triggerSummary("schedule", config("""{"cronExpression":"0 9 * * 1-5"}""")))
        assertEquals("webhook", triggerSummary("webhook", null))
        assertEquals("/api/hooks/docs-gardener-hook", triggerSummary("webhook", config("""{"path":"docs-gardener-hook"}""")))
        assertEquals("Ticket · any label", triggerSummary("ticket", null))
        assertEquals("Linear · docs, cleanup", triggerSummary("ticket", config("""{"source":"linear","labels":["docs","cleanup"]}""")))
        assertEquals("any event", triggerSummary("github", null))
        assertEquals("pr opened · @octocat · acme/web", triggerSummary("github", config("""{"events":["pr_opened"],"login":"octocat","repos":["acme/web"]}""")))
        assertEquals("mr merged · @jane · group/app", triggerSummary("gitlab", config("""{"events":["mr_merged"],"username":"jane","projects":["group/app"]}""")))
        assertEquals("#channel", triggerSummary("slack", null))
        assertEquals("#C0123ABCD · @-mentions only · “docs” · with threads", triggerSummary("slack", config("""{"channelId":"C0123ABCD","mentionOnly":true,"keyword":"docs","includeThreads":true}""")))
        assertEquals("transitioned · ENG · Done", triggerSummary("jira", config("""{"events":["transitioned"],"projects":["ENG"],"statuses":["Done"]}""")))
        assertEquals("incident triggered · high urgency", triggerSummary("pagerduty", config("""{"events":["incident.triggered"],"urgency":"high"}""")))
        assertEquals("issue created", triggerSummary("pylon", config("""{"events":["issue_created"]}""")))
        assertEquals("metric alert critical · api", triggerSummary("sentry", config("""{"events":["metric_alert_critical"],"projects":["api"]}""")))
        assertEquals("firing, resolved · optio", triggerSummary("alertmanager", config("""{"events":["firing","resolved"],"receivers":["optio"]}""")))
        assertEquals("no data · P1 · Checkout latency", triggerSummary("datadog", config("""{"events":["no_data"],"priorities":["P1"],"monitors":["Checkout latency"]}""")))
        assertEquals("By hand", triggerSummary("manual", null))
        assertEquals("carrier-pigeon", triggerSummary("carrier-pigeon", null))
    }

    @Test
    fun triggerParamsPerType() {
        assertEquals(emptyList(), triggerParams(WhenType.MANUAL))
        assertTrue("ticketTitle" in triggerParams(WhenType.TICKET))
        assertTrue("alertnames" in triggerParams(WhenType.ALERTMANAGER))
        assertTrue("monitors" !in triggerParams(WhenType.DATADOG) && "scope" in triggerParams(WhenType.DATADOG))
    }
}
