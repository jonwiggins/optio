package dev.optio.feature.local.model

import dev.optio.core.model.OptioJson
import dev.optio.feature.local.api.LocalTrigger
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Test

/** [Triggers]: the web's `triggerSummary` vectors and the Add trigger form's `build()` rules. */
class TriggersTest {
    private fun config(json: String): JsonObject = OptioJson.parseToJsonElement(json).jsonObject

    private fun summary(
        type: String,
        json: String,
    ) = Triggers.summary(type, config(json))

    @Test
    fun summariesReadLikeTheWeb() {
        assertEquals("0 9 * * 1-5", summary("schedule", """{"cronExpression":"0 9 * * 1-5"}"""))
        assertEquals("POST /api/hooks/local-abc", summary("webhook", """{"path":"local-abc"}"""))
        assertEquals("github · bug, p1", summary("ticket", """{"source":"github","labels":["bug","p1"]}"""))
        assertEquals("any source", summary("ticket", "{}"))
        assertEquals(
            "review_requested, mentioned → @octo in acme/web",
            summary("github", """{"events":["review_requested","mentioned"],"login":"octo","repos":["acme/web"]}"""),
        )
        assertEquals("C0123ABCD (@-mentions) · \"deploy\"", summary("slack", """{"channelId":"C0123ABCD","mentionOnly":true,"keyword":"deploy"}"""))
        assertEquals("assigned → jon in ENG", summary("linear", """{"events":["assigned"],"user":"jon","teams":["ENG"]}"""))
        assertEquals("any", summary("linear", "{}"))
    }

    @Test
    fun aBlankGithubLoginIsOmitted() {
        // automations-section.test.ts: "omits a blank login on github triggers"
        assertEquals("review_requested", summary("github", """{"events":["review_requested"],"login":""}"""))
    }

    @Test
    fun theRouteRowDecodesWithItsDates() {
        val t =
            OptioJson.decodeFromString<LocalTrigger>(
                """{"id":"t1","targetType":"local_blueprint","targetId":"bp","type":"schedule","config":{"cronExpression":"0 9 * * *"},
                    "paramMapping":null,"enabled":true,"lastFiredAt":null,"nextFireAt":"2026-09-23T09:00:00.000Z",
                    "createdAt":"2026-09-22T23:58:07.020Z","updatedAt":"2026-09-22T23:58:07.020Z"}""",
            )
        assertEquals("Schedule", Triggers.label(t))
        assertEquals("0 9 * * *", Triggers.summary(t))
        assertEquals(java.time.Instant.parse("2026-09-23T09:00:00Z"), t.nextFireAt)
        assertEquals("GitHub", Triggers.label(t.copy(type = "github")))
        assertEquals("Manual", Triggers.label(t.copy(type = "manual")), "a kind this app doesn't create still reads")
    }

    @Test
    fun buildValidatesEachKind() {
        fun problem(d: Triggers.Draft) = Triggers.build(d).exceptionOrNull()?.message
        fun ok(d: Triggers.Draft) = Triggers.build(d).getOrThrow().toString()

        assertEquals("Cron expression needs five space-separated fields", problem(Triggers.Draft(cron = "0 9 * *")))
        assertEquals("""{"cronExpression":"0 9 * * *"}""", ok(Triggers.Draft(cron = " 0 9 * * * ")))

        assertEquals("Webhook path is required", problem(Triggers.Draft(kind = TriggerKind.WEBHOOK, path = " ")))
        assertEquals("""{"path":"my-hook"}""", ok(Triggers.Draft(kind = TriggerKind.WEBHOOK, path = "my-hook")))

        assertEquals("""{"source":"linear","labels":["bug","p1"]}""", ok(Triggers.Draft(kind = TriggerKind.TICKET, source = "linear", labels = "bug, p1, ")))

        val gh = Triggers.Draft(kind = TriggerKind.GITHUB, githubEvents = setOf("mentioned", "review_requested"))
        assertEquals("Your GitHub username is required for those events", problem(gh))
        assertEquals(
            """{"events":["review_requested","mentioned"],"login":"octo","repos":["acme/web"]}""",
            ok(gh.copy(githubLogin = "@octo", githubRepos = "acme/web")),
        )
        assertEquals("""{"events":["pr_opened"]}""", ok(Triggers.Draft(kind = TriggerKind.GITHUB, githubEvents = setOf("pr_opened"))))
        assertEquals("Pick at least one GitHub event", problem(Triggers.Draft(kind = TriggerKind.GITHUB, githubEvents = emptySet())))

        val slack = Triggers.Draft(kind = TriggerKind.SLACK, channelId = "general")
        assertTrue(problem(slack)!!.startsWith("Slack channel id looks wrong"))
        assertEquals(
            """{"channelId":"C0123ABCD","keyword":"deploy","mentionOnly":true}""",
            ok(slack.copy(channelId = "C0123ABCD", keyword = " deploy ", mentionOnly = true)),
        )

        val linear = Triggers.Draft(kind = TriggerKind.LINEAR, linearEvents = setOf("assigned"))
        assertEquals("Your Linear name or user id is required for those events", problem(linear))
        assertEquals(
            """{"events":["created"],"labels":["bug"],"teams":["ENG"]}""",
            ok(Triggers.Draft(kind = TriggerKind.LINEAR, linearEvents = setOf("created"), labels = "bug", linearTeams = "ENG")),
        )
    }
}
