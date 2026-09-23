package dev.optio.feature.agents

import kotlin.random.Random
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Test

/** The New trigger sheet's rules: the server's validation, and the `config` shapes it accepted. */
class AgentTriggersTest {
    private fun config(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    @Test
    fun cronNeedsFiveFields() {
        assertTrue(AgentTriggers.cronIsValid("0 9 * * 1-5"))
        assertTrue(AgentTriggers.cronIsValid("  */5   * * * *  "))
        assertFalse(AgentTriggers.cronIsValid("0 9 * *"))
        assertFalse(AgentTriggers.cronIsValid("0 9 * * * *"))
        assertFalse(AgentTriggers.cronIsValid(""))
        assertFalse(AgentTriggers.cronIsValid(null))
    }

    @Test
    fun randomWebhookPathsLookLikeTheWebs() {
        val path = AgentTriggers.randomWebhookPath(Random(7))
        assertTrue(Regex("^hook-[a-z0-9]{8}$").matches(path), path)
    }

    @Test
    fun scheduleDraft() {
        val draft = AgentTriggerDraft(type = AgentTriggerType.SCHEDULE, cron = " 0 9 * * 1 ")
        assertNull(draft.validation)
        assertEquals(config("""{"cronExpression":"0 9 * * 1"}"""), draft.config())
        assertEquals("Wakes the agent Mondays at 09:00 UTC.", draft.footer)
        assertEquals("Five-field cron expression, in UTC.", draft.copy(cron = "15 3 * * *").footer)
        assertEquals("Expected five space-separated fields.", draft.copy(cron = "15 3").validation)
    }

    @Test
    fun webhookDraft() {
        val draft = AgentTriggerDraft(type = AgentTriggerType.WEBHOOK, webhookPath = "release-hook")
        assertNull(draft.validation)
        assertEquals(config("""{"path":"release-hook"}"""), draft.config())
        assertEquals("Pick a path for the webhook.", draft.copy(webhookPath = " ").validation)
        assertEquals("The path is one segment: no spaces or slashes.", draft.copy(webhookPath = "a/b").validation)
    }

    @Test
    fun ticketDraft() {
        val draft = AgentTriggerDraft(type = AgentTriggerType.TICKET)
        assertEquals(config("""{"source":"github"}"""), draft.config())
        val labelled = draft.copy(ticketSource = "linear", ticketLabels = listOf("docs", "cleanup"))
        assertEquals(config("""{"source":"linear","labels":["docs","cleanup"]}"""), labelled.config())
        assertNull(labelled.validation)
    }

    @Test
    fun githubDraftNeedsALoginForPersonalEvents() {
        val draft = AgentTriggerDraft(type = AgentTriggerType.GITHUB)
        assertTrue(draft.needsPerson)
        assertEquals("Add a GitHub username — review, mention and assign events are about someone.", draft.validation)
        val withLogin = draft.copy(githubLogin = "@octocat")
        assertNull(withLogin.validation)
        assertEquals(config("""{"events":["review_requested","mentioned"],"login":"octocat"}"""), withLogin.config())
        // Only "any PR / issue" kinds: nobody to name.
        val anyPr = draft.copy(githubEvents = listOf("pr_opened", "issue_opened"))
        assertFalse(anyPr.needsPerson)
        assertNull(anyPr.validation)
        assertEquals(config("""{"events":["pr_opened","issue_opened"]}"""), anyPr.config())
    }

    @Test
    fun linearDraft() {
        val draft = AgentTriggerDraft(type = AgentTriggerType.LINEAR)
        assertEquals("Add a Linear user — assign and mention events are about someone.", draft.validation)
        assertEquals(config("""{"events":["assigned","mentioned"],"user":"Jane Doe"}"""), draft.copy(linearUser = "Jane Doe").config())
        val created = draft.copy(linearEvents = listOf("created", "labeled"))
        assertNull(created.validation)
        assertEquals(config("""{"events":["created","labeled"]}"""), created.config())
    }

    @Test
    fun slackDraftNeedsAChannelId() {
        val draft = AgentTriggerDraft(type = AgentTriggerType.SLACK)
        assertEquals("Slack channel ids look like C0123ABCD.", draft.validation)
        assertEquals("Slack channel ids look like C0123ABCD.", draft.copy(slackChannel = "general").validation)
        val ok = draft.copy(slackChannel = "C0123ABCD", slackMentionOnly = true, slackKeyword = " docs ")
        assertNull(ok.validation)
        assertEquals(config("""{"channelId":"C0123ABCD","mentionOnly":true,"keyword":"docs"}"""), ok.config())
        assertEquals(
            config("""{"channelId":"C0123ABCD","mentionOnly":false,"includeThreads":true}"""),
            draft.copy(slackChannel = "C0123ABCD", slackIncludeThreads = true).config(),
        )
    }

    @Test
    fun manualDraftHasNoConfig() {
        val draft = AgentTriggerDraft(type = AgentTriggerType.MANUAL)
        assertNull(draft.validation)
        assertEquals(JsonObject(emptyMap()), draft.config())
        assertEquals(PersistentAgentTriggerInput("manual", JsonObject(emptyMap()), true), draft.input())
    }

    @Test
    fun switchingTypeKeepsEachTypesAnswers() {
        val draft = AgentTriggerDraft(cron = "0 * * * *").copy(type = AgentTriggerType.WEBHOOK, webhookPath = "x").copy(type = AgentTriggerType.SCHEDULE)
        assertEquals("0 * * * *", draft.cron)
        assertEquals("x", draft.webhookPath)
    }

    @Test
    fun summariesOfOddRows() {
        assertEquals("cron", AgentTriggers.summary("schedule", emptyMap()))
        assertEquals("webhook", AgentTriggers.summary("webhook", emptyMap()))
        assertEquals("Ticket · any label", AgentTriggers.summary("ticket", emptyMap()))
        assertEquals("any event", AgentTriggers.summary("github", emptyMap()))
        assertEquals("#channel", AgentTriggers.summary("slack", emptyMap()))
        assertEquals("carrier-pigeon", AgentTriggers.summary("carrier-pigeon", emptyMap()))
        assertEquals(
            "pr opened · @octocat · acme/web",
            AgentTriggers.summary("github", config("""{"events":["pr_opened"],"login":"octocat","repos":["acme/web"]}""")),
        )
    }
}
