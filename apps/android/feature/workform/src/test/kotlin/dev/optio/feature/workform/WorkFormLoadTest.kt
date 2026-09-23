package dev.optio.feature.workform

import dev.optio.core.model.OptioJson
import dev.optio.core.testing.FakeOptioServerRule
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Rule
import org.junit.Test

/**
 * Ports `apps/web/src/components/work-form/load.test.ts`: a saved row reopened in the form must
 * land on the kind it was saved as (otherwise the lock would refuse every change) and must be
 * submittable as-is (no gaps the user didn't leave).
 */
class WorkFormLoadTest {
    @get:Rule
    val rule = FakeOptioServerRule()

    private fun obj(json: String): JsonObject = OptioJson.parseToJsonElement(json).jsonObject

    // region draftFromRow: the row round-trips to its own kind

    @Test
    fun scheduledPodTask() {
        val d = draftFromRow(
            EditableKind.REPO_BLUEPRINT,
            obj(
                """{"name":"Nightly sweep","title":"Nightly sweep","prompt":"Sweep","repoUrl":"https://github.com/acme/app",
                "repoBranch":"develop","agentType":"codex","agentOptions":{"model":"gpt-5"},"priority":7,"maxRetries":1,"runTarget":"cluster"}""",
            ),
            obj("""{"type":"schedule","config":{"cronExpression":"0 9 * * 1-5"}}"""),
        )
        assertEquals(WorkKind.REPO_BLUEPRINT, deriveKind(d))
        assertEquals(WhenType.SCHEDULE, d.whenType)
        assertEquals("0 9 * * 1-5", d.trigger.cronExpression)
        assertEquals("codex", d.runtime)
        assertEquals(mapOf("model" to OptionValue.Str("gpt-5")), d.agentOptions)
        assertEquals("develop", d.repoBranch)
        assertEquals(7, d.priority)
        assertEquals(1, d.maxRetries)
        assertEquals(emptyList(), missingFields(d))
    }

    @Test
    fun jobOnAMachineFoldsTheLegacyModelColumn() {
        val d = draftFromRow(
            EditableKind.STANDALONE,
            obj(
                """{"name":"Digest","promptTemplate":"Summarize {{ticketTitle}}","agentRuntime":"claude-code","model":"opus",
                "agentOptions":null,"maxRetries":2,"runTarget":"local","localHostId":"h1","localDir":"/Users/dev/notes","localSessionMode":"headless"}""",
            ),
            obj("""{"type":"ticket","config":{"source":"linear","labels":["bug"]}}"""),
        )
        assertEquals(WorkKind.STANDALONE, deriveKind(d))
        assertEquals(WhenType.TICKET, d.whenType)
        assertEquals(TriggerConfig(type = TriggerType.TICKET, ticketSource = TicketSource.LINEAR, ticketLabels = listOf("bug")), d.trigger)
        assertEquals(RunLocation(Where.LOCAL, "h1", "/Users/dev/notes", LocalSessionMode.HEADLESS), d.location)
        assertEquals(OptionValue.Str("opus"), d.agentOptions["claudeModel"])
        assertEquals(Then.EXITS, d.then)
        assertEquals(2, d.maxRetries)
    }

    @Test
    fun localAutomationOnANewBranchWithAGitHubEvent() {
        val d = draftFromRow(
            EditableKind.LOCAL_BLUEPRINT,
            obj(
                """{"name":"Reviews","hostId":"h1","dir":"/Users/dev/repos/app","repoUrl":"https://github.com/acme/app",
                "baseBranch":"main","commandTemplate":"Review PR {{number}}","agent":"claude-code","sessionMode":"interactive"}""",
            ),
            obj("""{"type":"github","config":{"events":["review_requested"],"login":"octocat"}}"""),
        )
        assertEquals(WorkKind.LOCAL_BLUEPRINT, deriveKind(d))
        assertEquals(WhenType.GITHUB, d.whenType)
        assertEquals(EventTrigger(EventTriggerType.GITHUB, obj("""{"events":["review_requested"],"login":"octocat"}""")), d.event)
        assertTrue(d.withRepo)
        assertEquals(Then.WAITS_FOR_ME, d.then)
        assertEquals(emptyList(), missingFields(d))
    }

    @Test
    fun headlessScheduledAutomationWithNoBranchSitsOnTheJobPointAndTheLockAllowsIt() {
        val d = draftFromRow(
            EditableKind.LOCAL_BLUEPRINT,
            obj(
                """{"name":"Sync","hostId":"h1","dir":"/Users/dev/notes","baseBranch":null,"commandTemplate":"Sync notes",
                "agent":"codex","sessionMode":"headless"}""",
            ),
            obj("""{"type":"schedule","config":{"cronExpression":"0 * * * *"}}"""),
        )
        // The form would file this as a Job on a machine; the save still patches the blueprint.
        assertEquals(WorkKind.STANDALONE, deriveKind(d))
        assertEquals(false, d.withRepo)
        assertEquals(Then.EXITS, d.then)
        assertEquals("codex", d.runtime)
        assertNull(kindLock(d, WorkKind.LOCAL_BLUEPRINT) { it.copy(prompt = "x") })
        // A new branch on a schedule is a scheduled Task on a machine: a different row.
        assertTrue(kindLock(d, WorkKind.LOCAL_BLUEPRINT) { it.copy(withRepo = true) }!!.contains("automation"))
        // Waiting for you between turns is an interactive automation: still this row.
        assertNull(kindLock(d, WorkKind.LOCAL_BLUEPRINT) { it.copy(then = Then.WAITS_FOR_ME) })
    }

    @Test
    fun runNamesReadBackBlankWhenTheyJustRepeatTheName() {
        val linear = obj("""{"type":"linear","config":{"events":["mentioned"],"user":"jon"}}""")
        val task = """"name":"Triage","prompt":"p","repoUrl":"https://github.com/a/b""""
        assertEquals(
            "Triage: {{ticketTitle}}",
            draftFromRow(EditableKind.REPO_BLUEPRINT, obj("""{$task,"title":"Triage: {{ticketTitle}}"}"""), linear).runName,
        )
        assertEquals("", draftFromRow(EditableKind.REPO_BLUEPRINT, obj("""{$task,"title":"Triage"}"""), linear).runName)
        assertEquals(
            "Job: {{title}}",
            draftFromRow(EditableKind.STANDALONE, obj("""{"name":"Triage","promptTemplate":"p","runTitle":"Job: {{title}}"}"""), linear).runName,
        )
        assertEquals(
            "T: {{title}}",
            draftFromRow(
                EditableKind.LOCAL_BLUEPRINT,
                obj("""{"name":"Triage","commandTemplate":"p","agent":"claude-code","runTitle":"T: {{title}}"}"""),
                linear,
            ).runName,
        )
    }

    // endregion

    // region whenFromTrigger / pickTrigger

    @Test
    fun mapsEachStoredTriggerTypeBackToTheFormsWhen() {
        assertEquals(TriggerConfig(type = TriggerType.WEBHOOK, webhookPath = "hook-1"), whenFromTrigger(obj("""{"type":"webhook","config":{"path":"hook-1"}}""")).trigger)
        assertEquals(WhenType.SLACK, whenFromTrigger(obj("""{"type":"slack","config":{"channelId":"C0123ABCD"}}""")).whenType)
        assertEquals(WhenType.MANUAL, whenFromTrigger(null).whenType)
        assertEquals(WhenType.MANUAL, whenFromTrigger(obj("""{"type":"manual"}""")).whenType)
    }

    @Test
    fun prefersTheFirstEnabledTrigger() {
        assertEquals(
            "b",
            pickTrigger(listOf(obj("""{"id":"a","type":"webhook","enabled":false}"""), obj("""{"id":"b","type":"schedule","enabled":true}""")))!!.text("id"),
        )
        assertEquals("a", pickTrigger(listOf(obj("""{"id":"a","enabled":false}""")))!!.text("id"))
        assertNull(pickTrigger(emptyList()))
    }

    // endregion

    // region kindLock: an edit stays inside its saved kind

    private val job = draftFromRow(
        EditableKind.STANDALONE,
        obj("""{"name":"Digest","promptTemplate":"p","agentRuntime":"claude-code","runTarget":"cluster"}"""),
        obj("""{"type":"schedule","config":{"cronExpression":"0 9 * * *"}}"""),
    )

    @Test
    fun allowsChangesThatKeepTheKindAndRefusesOnesThatMoveIt() {
        assertNull(kindLock(job, WorkKind.STANDALONE) { it.copy(runtime = "codex") })
        assertNull(kindLock(job, WorkKind.STANDALONE) { it.copy(trigger = TriggerConfig(TriggerType.WEBHOOK), whenType = WhenType.WEBHOOK) })
        // A repo would make it a scheduled Task.
        assertTrue(kindLock(job, WorkKind.STANDALONE) { it.copy(withRepo = true) }!!.contains("saved as a Job"))
        // Waiting for messages would make it a persistent agent.
        assertTrue(kindLock(job, WorkKind.STANDALONE) { it.copy(then = Then.WAITS_FOR_MESSAGES) }!!.contains("saved as a Job"))
        // A GitHub event is just another When: still a Job, still in its pod.
        assertNull(kindLock(job, WorkKind.STANDALONE) { it.copy(whenType = WhenType.GITHUB) })
    }

    @Test
    fun kindLockIsANoOpWhenNothingIsLocked() {
        assertNull(kindLock(job, null) { it.copy(withRepo = true) })
    }

    // endregion

    // region loadEditTarget

    @Test
    fun resolvesAUnifiedIdAndItsTriggers() = runTest {
        val server = rule.server
        server.json("/api/tasks/w-1", """{"task":{"type":"standalone","id":"w-1","name":"Digest","promptTemplate":"p"}}""")
        server.json("/api/tasks/w-1/triggers", """{"triggers":[{"id":"t1","type":"schedule","config":{"cronExpression":"0 9 * * *"},"enabled":true}]}""")
        val target = loadEditTarget(server.client(), "w-1")
        assertEquals(EditableKind.STANDALONE, target.kind)
        assertEquals("t1", target.trigger?.text("id"))
        assertEquals(WhenType.SCHEDULE, target.draft.whenType)
        assertEquals(0, server.count(path = "/api/local/blueprints/w-1"))
    }

    @Test
    fun fallsThroughToLocalAutomationsOnA404() = runTest {
        val server = rule.server
        server.error("GET", "/api/tasks/b-1", 404, "Task not found")
        server.json("/api/local/blueprints/b-1", """{"blueprint":{"id":"b-1","name":"Reviews","hostId":"h1","dir":"/x","commandTemplate":"p"}}""")
        server.json("/api/local/blueprints/b-1/triggers", """{"triggers":[]}""")
        val target = loadEditTarget(server.client(), "b-1")
        assertEquals(EditableKind.LOCAL_BLUEPRINT, target.kind)
        assertNull(target.trigger)
        assertEquals("Reviews", target.savedName)
    }

    @Test
    fun refusesAOneShotTask() = runTest {
        val server = rule.server
        server.json("/api/tasks/t-1", """{"task":{"type":"repo-task","id":"t-1"}}""")
        assertFailsWith<NotEditableException> { loadEditTarget(server.client(), "t-1") }
    }

    @Test
    fun unknownIdIsNotEditable() = runTest {
        val server = rule.server
        server.error("GET", "/api/tasks/nope", 404, "Task not found")
        server.error("GET", "/api/local/blueprints/nope", 404, "Blueprint not found")
        server.json("/api/local/blueprints/nope/triggers", """{"triggers":[]}""")
        val e = assertFailsWith<NotEditableException> { loadEditTarget(server.client(), "nope") }
        assertNotNull(e.message)
    }

    @Test
    fun detailRoutesPerKind() {
        val row = JsonObject(emptyMap())
        assertEquals(
            dev.optio.core.navigation.routes.ScheduledDetailRoute("x"),
            EditTarget("x", EditableKind.REPO_BLUEPRINT, row, null, emptyList(), WorkDraft.EMPTY).detailRoute,
        )
        assertEquals(
            dev.optio.core.navigation.routes.JobDetailRoute("x"),
            EditTarget("x", EditableKind.STANDALONE, row, null, emptyList(), WorkDraft.EMPTY).detailRoute,
        )
        assertEquals(
            dev.optio.core.navigation.routes.LocalAutomationRoute("x"),
            EditTarget("x", EditableKind.LOCAL_BLUEPRINT, row, null, emptyList(), WorkDraft.EMPTY).detailRoute,
        )
    }

    // endregion
}
