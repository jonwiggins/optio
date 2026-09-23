package dev.optio.feature.workform

import dev.optio.core.model.OptioJson
import dev.optio.core.navigation.routes.JobRunRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.Fixtures
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.concurrent.Executors
import kotlin.test.AfterTest
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Before
import org.junit.Rule
import org.junit.Test

/**
 * The form state against a fake API serving fixtures captured from the private test API: loading
 * the lists, the repo pre-select and parameter seeding, host adoption, the auto name, the GitHub
 * login prefill, the dev script, and submit (success and a refused create).
 */
class WorkFormStateTest {
    @get:Rule
    val rule = FakeOptioServerRule()

    private val server: FakeOptioServer
        get() = rule.server

    // One thread, like `Dispatchers.Main` in the app: the state is never written concurrently.
    private val executor = Executors.newSingleThreadExecutor()
    private val dispatcher = executor.asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val clock = Clock.fixed(Instant.parse("2026-09-22T16:40:00Z"), ZoneOffset.UTC)

    @AfterTest
    fun tearDown() {
        scope.cancel()
        executor.shutdownNow()
    }

    @Before
    fun routes() {
        AgentCatalogCache.clear()
        server.fixture("/api/repos", "workform-repos.json")
        server.fixture("/api/local/hosts", "workform-local-hosts.json")
        server.fixture("/api/prompt-templates", "workform-prompt-templates.json")
        server.on("GET", "/api/tasks") { req ->
            if (req.queryParam("type") == "all") FakeResponse.fixture("workform-tasks-count.json") else FakeResponse.fixture("workform-tasks.json")
        }
        server.fixture("/api/auth/me", "auth-me.json")
        server.fixture("/api/agents/anthropic/options", "workform-options-anthropic.json")
        server.fixture("/api/agents/openai/options", "workform-options-openai.json")
        server.fixture("/api/agents/opencode/options", "workform-options-opencode.json")
    }

    private fun newState(preset: String? = null, edit: EditTarget? = null): WorkFormState =
        runBlocking(dispatcher) { WorkFormState(server.client(), scope, presetId = preset, edit = edit, clock = clock) }

    /** Runs [block] on the state's thread (reads and writes of the draft stay single-threaded). */
    private fun <T> on(block: () -> T): T = runBlocking { withContext(dispatcher) { block() } }

    private fun awaitUntil(what: String, timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!on(condition)) {
            check(System.currentTimeMillis() < deadline) { "Timed out waiting for $what" }
            Thread.sleep(10)
        }
    }

    private fun loaded(preset: String? = null): WorkFormState {
        val state = newState(preset)
        on { state.load() }
        awaitUntil("lists") {
            !state.reposLoading && !state.hostsLoading && state.workCount != null && state.templates.isNotEmpty() &&
                state.catalogState is CatalogState.Loaded && state.me != null
        }
        return state
    }

    @Test
    fun loadsTheListsPreselectsTheFirstRepoAndSeedsItsParameters() {
        val state = loaded()
        on {
            assertEquals("pr", state.preset)
            assertEquals(listOf("e2e-org/e2e-repo", "e2e-org/mobile-app"), state.repos.map { it.fullName })
            assertEquals("https://github.com/e2e-org/e2e-repo", state.draft.repoUrl)
            assertEquals("main", state.draft.repoBranch)
            // Every catalog key the repo sets, once the catalog is known.
            assertEquals(
                mapOf(
                    "claudeModel" to OptionValue.Str("opus"),
                    "claudeContextWindow" to OptionValue.Str("1m"),
                    "claudeEffort" to OptionValue.Str("high"),
                    "claudeThinking" to OptionValue.Bool(true),
                ),
                state.draft.agentOptions,
            )
            assertEquals("Opus 4.8", state.modelLabel)
            assertEquals("Claude Code · Opus 4.8", state.summaryWho)
            assertEquals("Optio pod · e2e-org/e2e-repo", state.summaryWhere)
            assertEquals(4, state.templates.size)
            assertEquals(13, state.workCount)
            assertEquals("Task 14", state.autoName)
            assertEquals(
                "Started now, a Claude Code run in an Optio pod with e2e-org/e2e-repo that opens a PR and exits when done.",
                sentenceText(state.sentence),
            )
            assertEquals(listOf(SentenceField.PROMPT), state.gaps)
            assertFalse(state.canSubmit)
            assertEquals(SentenceField.PROMPT, state.firstGap)
            // The hosts are known, but a pod run doesn't adopt one.
            assertEquals("", state.draft.location.localHostId)
        }
    }

    @Test
    fun aMachineAdoptsTheFirstHostAndAUsableDirectory() {
        val state = loaded()
        on {
            state.setWhere(Where.LOCAL)
            val d = state.draft
            assertEquals("30194174-0c57-4aa9-9ebd-cbe321d09172", d.location.localHostId)
            assertFalse(d.withRepo, "a machine defaults to the directory as it is")
            assertEquals("/Users/e2e/repos/e2e-repo", d.location.localDir)
            assertEquals(emptyMap(), d.agentOptions, "a machine carries only what the user picks")
            assertEquals("E2E laptop", state.summaryWhere)

            state.setDir("/Users/e2e/notes")
            state.setWithRepo(true)
            // A new branch needs a git checkout: the plain directory is swapped for the checkout.
            assertEquals("/Users/e2e/repos/e2e-repo", state.draft.location.localDir)
            assertEquals("https://github.com/e2e-org/e2e-repo", state.effectiveRepoUrl)
            assertEquals("E2E laptop · new branch", state.summaryWhere)
            assertFalse(state.usableDir(state.dirs.first { it.path == "/Users/e2e/notes" }))
            assertTrue(
                sentenceText(state.sentence).contains("on E2E laptop on a new branch in ~/repos/e2e-repo that opens a PR"),
                sentenceText(state.sentence),
            )
        }
    }

    @Test
    fun presetsAndTheTerminal() {
        val state = loaded()
        on {
            state.applyPreset("terminal")
            assertEquals("terminal", state.preset)
            assertEquals(WorkKind.LOCAL_TERMINAL, state.kind)
            assertTrue(state.isTerminal)
            assertEquals("Terminal 14", state.autoName)
            assertEquals("Open session", state.submitLabel)
            assertEquals(emptyList(), state.gaps)
            assertTrue(state.canSubmit)
            state.setName("Scratch")
            assertNull(state.preset, "any edit drops the preset highlight")

            state.applyPreset("agent")
            assertEquals(WorkKind.PERSISTENT_AGENT, state.kind)
            assertEquals("Create agent", state.submitLabel)
            assertEquals("Persistent agent", state.summaryThen)
        }
    }

    @Test
    fun whenDefaultsAndTheGitHubLoginPrefill() {
        val state = loaded()
        on {
            state.setWhen(WhenType.SCHEDULE)
            assertEquals("0 9 * * *", state.draft.trigger.cronExpression)
            state.setWhen(WhenType.WEBHOOK)
            assertTrue(state.draft.trigger.webhookPath!!.startsWith("hook-"))
            assertEquals("0 9 * * *", state.draft.trigger.cronExpression, "switching back keeps the cron")
            state.setWhen(WhenType.TICKET)
            assertEquals(TicketSource.GITHUB, state.draft.trigger.ticketSource)
            state.addTicketLabel(" bug ")
            state.addTicketLabel("bug")
            state.addTicketLabel("")
            assertEquals(listOf("bug"), state.draft.trigger.ticketLabels)
            state.removeTicketLabel("bug")
            assertEquals(emptyList(), state.draft.trigger.ticketLabels)

            // The fixture's user is "local" (auth disabled): no login to prefill, so "about you" is a gap.
            state.setWhen(WhenType.GITHUB)
            assertEquals(listOf(SentenceField.IDENTITY, SentenceField.PROMPT), state.gaps)
            state.setEventField("login", JsonPrimitive("octocat"))
            state.setPrompt("Review {{url}}")
            assertEquals(emptyList(), state.gaps)
            state.toggleEventKind("review_requested")
            state.toggleEventKind("mentioned")
            assertEquals(listOf(SentenceField.EVENTS), state.gaps)
        }
    }

    @Test
    fun aGitHubAccountFillsInTheLogin() {
        server.json("/api/auth/me", """{"user":{"id":"u1","provider":"github","username":"octocat","email":"o@example.com"},"authDisabled":false}""")
        val state = loaded()
        on {
            state.setWhen(WhenType.GITHUB)
            assertEquals("octocat", state.draft.event.config.string("login"))
        }
    }

    @Test
    fun runtimeChangesFetchTheirCatalogAndOnlyTheModelSurvivesOnAMachine() {
        val state = loaded()
        on { state.setRuntime("opencode") }
        awaitUntil("opencode catalog") { state.catalogs["opencode"] is CatalogState.Loaded }
        on {
            assertTrue(state.catalog?.modelIsFreeText == true)
            assertEquals(emptyMap(), state.draft.agentOptions, "opencode has no repo parameters set")
            state.setOption("opencodeModel", OptionValue.Str("anthropic/claude-sonnet-4"))
            assertEquals("OpenCode · anthropic/claude-sonnet-4", state.summaryWho)
            state.setWhere(Where.LOCAL)
            assertEquals("opencode", state.draft.runtime, "OpenCode runs locally, so it stays")
            assertEquals(emptyMap(), state.draft.agentOptions, "moving starts the parameters over")
            state.setRuntime("copilot")
            assertEquals("claude-code", state.draft.runtime, "Copilot runs in pods only: the first agent that can run here takes over")
        }
    }

    @Test
    fun theAutoNameFallsBackToATimestampWithoutATotal() {
        server.on("GET", "/api/tasks") { FakeResponse.json("""{"tasks":[],"limit":1,"offset":0}""") }
        val state = newState()
        on { state.load() }
        awaitUntil("lists") { !state.reposLoading && !state.hostsLoading }
        Thread.sleep(100)
        on { assertEquals("Task 2026-09-22 16:40", state.autoName) }
    }

    @Test
    fun submitCreatesAJobAndReportsWhereToGo() {
        server.post("/api/tasks") { FakeResponse.fixture("workform-create-job.json", 201) }
        server.post("/api/tasks/:id/runs") { FakeResponse.fixture("workform-create-run.json", 202) }
        val state = loaded()
        val created = runBlocking(dispatcher) {
            state.setWithRepo(false)
            state.setPrompt("Say hi")
            assertTrue(state.canSubmit)
            state.submit()
        }
        assertNotNull(created)
        assertEquals(JobRunRoute("72f6b823-fb5b-448d-93a8-f00e72df6bb8", "4f633714-106a-4748-8508-a7b83cb4c141"), created.route)
        assertEquals("Job 14 started", created.toast)
        val body = server.lastRequest("POST", "/api/tasks")!!.json.jsonObject
        assertEquals("Job 14", body.text("name"))
        on { assertFalse(state.submitting) }
    }

    @Test
    fun aRefusedCreateBecomesTheFormsError() {
        server.error("POST", "/api/local/terminals", 400, "Host not found")
        val state = loaded("chat")
        val created = runBlocking(dispatcher) { state.submit() }
        assertNull(created)
        on {
            assertEquals("Couldn't create it: Host not found", state.error)
            assertFalse(state.submitting)
        }
    }

    @Test
    fun aLocalChatOpensATerminal() {
        server.post("/api/local/terminals") { FakeResponse.json("""{"terminal":{"id":"lt-9"}}""", 201) }
        val state = loaded("chat")
        val created = runBlocking(dispatcher) { state.submit() }
        assertEquals(LocalTerminalRoute("lt-9"), created?.route)
        val body = server.lastRequest("POST", "/api/local/terminals")!!.json.jsonObject
        assertEquals("/Users/e2e/repos/e2e-repo", body.text("dir"))
        assertEquals(OptioJson.parseToJsonElement("""{"kind":"agent","agent":"claude-code"}"""), body["spec"])
    }

    @Test
    fun theDevScriptWalksTheFormIntoAState() {
        val state = loaded()
        val submit = on { state.applyDevScript("schedule", "when=github,where=local,then=waits-for-me,more=1,prompt=hi,name=Nightly,scroll=who,submit=1") }
        assertTrue(submit)
        on {
            assertEquals(WhenType.GITHUB, state.draft.whenType)
            assertTrue(state.isLocal)
            assertEquals(Then.WAITS_FOR_ME, state.draft.then)
            assertEquals(WorkKind.LOCAL_BLUEPRINT, state.kind)
            assertTrue(state.more)
            assertEquals("hi", state.draft.prompt)
            assertEquals("Nightly", state.draft.name)
            assertEquals(FormSection.WHO, state.scrollRequest)
        }
    }

    @Test
    fun editingKeepsTheSavedRowAndLocksItsKind() {
        val row = OptioJson.parseToJsonElement(Fixtures.text("workform-get-job.json")).jsonObject["task"]!!.jsonObject
        val trigger = OptioJson.parseToJsonElement(Fixtures.text("workform-job-triggers.json")).jsonObject["triggers"]!!.let { (it as kotlinx.serialization.json.JsonArray)[0].jsonObject }
        val target = EditTarget(row.text("id"), EditableKind.STANDALONE, row, trigger, listOf(trigger), draftFromRow(EditableKind.STANDALONE, row, trigger))
        val state = newState(edit = target)
        on { state.load() }
        awaitUntil("lists") { !state.reposLoading && !state.hostsLoading }
        on {
            assertNull(state.preset)
            assertEquals("Save changes", state.submitLabel)
            assertEquals("Fixture job capture", state.namePlaceholder)
            assertEquals(WhenType.SCHEDULE, state.draft.whenType)
            assertEquals("Say hi [[mock:sleep:100]]", state.draft.prompt)
            assertFalse(state.draft.withRepo, "the repo pre-select doesn't turn a Job into a Task")
            // The lock: a repo or a persistent agent would move the row to another table.
            assertTrue(state.withRepoDisabled(true)!!.contains("saved as a Job"))
            assertTrue(state.thenChoices.first { it.value == Then.WAITS_FOR_MESSAGES }.disabled!!.isNotEmpty())
            assertNull(state.whenDisabled(WhenType.WEBHOOK))
            // An edit keeps withRepo when the Where changes.
            state.setWhere(Where.LOCAL)
            assertFalse(state.draft.withRepo)
            assertEquals(WorkKind.STANDALONE, state.kind)
        }
    }
}
