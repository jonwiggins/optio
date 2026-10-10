package dev.optio.feature.local.model

import dev.optio.core.model.OptioJson
import dev.optio.core.ui.components.BrandIcons
import dev.optio.feature.local.api.LocalTrigger
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Test

/** [Triggers]: an automation's trigger rows read through the app's one trigger model. */
class TriggersTest {
    private fun config(json: String): JsonObject = OptioJson.parseToJsonElement(json).jsonObject

    private fun summary(
        type: String,
        json: String,
    ) = Triggers.summary(type, config(json))

    @Test
    fun summariesReadTheSameAsEverywhereElse() {
        assertEquals("0 9 * * 1-5 · weekdays at 09:00 UTC", summary("schedule", """{"cronExpression":"0 9 * * 1-5"}"""))
        assertEquals("/api/hooks/local-abc", summary("webhook", """{"path":"local-abc"}"""))
        assertEquals("GitHub · bug, p1", summary("ticket", """{"source":"github","labels":["bug","p1"]}"""))
        assertEquals("Ticket · any label", summary("ticket", "{}"))
        assertEquals(
            "review requested, mentioned · @octo · acme/web",
            summary("github", """{"events":["review_requested","mentioned"],"login":"octo","repos":["acme/web"]}"""),
        )
        assertEquals("#C0123ABCD · @-mentions only · “deploy”", summary("slack", """{"channelId":"C0123ABCD","mentionOnly":true,"keyword":"deploy"}"""))
        assertEquals("assigned · jon · ENG", summary("linear", """{"events":["assigned"],"user":"jon","teams":["ENG"]}"""))
        assertEquals("any event", summary("linear", "{}"))
        assertEquals("assigned · Ada · from others", summary("linear", """{"events":["assigned"],"user":"Ada","othersOnly":true}"""))
        // The event types the automations editor gained.
        assertEquals("pipeline failed · group/app", summary("gitlab", """{"events":["pipeline_failed"],"projects":["group/app"]}"""))
        assertEquals("incident triggered · Checkout API · high urgency", summary("pagerduty", """{"events":["incident.triggered"],"services":["Checkout API"],"urgency":"high"}"""))
        assertEquals("firing · HighErrorRate · critical", summary("alertmanager", """{"events":["firing"],"alertnames":["HighErrorRate"],"severities":["critical"]}"""))
        assertEquals("triggered, recovered · P1", summary("datadog", """{"events":["triggered","recovered"],"priorities":["P1"]}"""))
        assertEquals("issue created · web · production", summary("sentry", """{"events":["issue_created"],"projects":["web"],"environments":["production"]}"""))
        assertEquals("any event", summary("pylon", "{}"))
    }

    @Test
    fun aBlankGithubLoginIsOmitted() {
        // automations-section.test.ts: "omits a blank login on github triggers"
        assertEquals("review requested", summary("github", """{"events":["review_requested"],"login":""}"""))
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
        assertEquals("0 9 * * * · daily at 09:00 UTC", Triggers.summary(t))
        assertEquals(java.time.Instant.parse("2026-09-23T09:00:00Z"), t.nextFireAt)
        assertEquals("GitHub", Triggers.label(t.copy(type = "github")))
        assertEquals("Manual", Triggers.label(t.copy(type = "manual")), "a kind this app doesn't create still reads")
        assertEquals("Carrier-pigeon", Triggers.label(t.copy(type = "carrier-pigeon")))
        assertEquals(BrandIcons.Datadog, Triggers.icon(t.copy(type = "datadog")))
        assertEquals(BrandIcons.Linear, Triggers.icon(t.copy(type = "ticket", config = config("""{"source":"linear"}"""))), "a ticket trigger wears its source's logo")
    }

    @Test
    fun aSelfSecretTriggersSecretIsReadOnceFromTheCreate() {
        val created = OptioJson.decodeFromString<LocalTrigger>("""{"id":"t2","type":"pylon","config":{"events":[],"secret":"s3cr3t"},"enabled":true}""")
        assertEquals("s3cr3t", Triggers.createdSecret(created))
        assertNull(Triggers.createdSecret(created.copy(config = config("""{"events":[],"hasSecret":true}"""))), "later reads only say it has one")
        assertNull(Triggers.createdSecret(created.copy(type = "webhook", config = config("""{"path":"x","secret":"s"}"""))), "only Pylon / Alertmanager / Datadog show a dialog")
    }
}
