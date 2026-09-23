package dev.optio.feature.workform

import dev.optio.core.model.OptioJson
import dev.optio.core.model.stringValue
import dev.optio.core.navigation.routes.AgentDetailRoute
import dev.optio.core.navigation.routes.JobDetailRoute
import dev.optio.core.navigation.routes.JobRunRoute
import dev.optio.core.navigation.routes.LocalAutomationRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.navigation.routes.ScheduledDetailRoute
import dev.optio.core.navigation.routes.SessionDetailRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.network.ApiClient
import java.io.File
import java.util.concurrent.Executors
import kotlin.test.AfterTest
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

/**
 * The New work form end to end against a real API (the private test API: real server, fake
 * runtime, seeded repo `e2e-org/e2e-repo` and offline machine "E2E laptop"), one draft per storage
 * kind like `apps/web/e2e/work-form.spec.ts`: the form state is driven the way the screen drives
 * it, submitted, and the row it made is read back over HTTP and checked for the fields the form
 * promised. Also: editing saved recurring work, the rollback of a rejected trigger, and the
 * name-clash bump. Skipped unless `OPTIO_TEST_API_URL` is set:
 *
 * ```
 * OPTIO_TEST_API_URL=http://127.0.0.1:4963 ./gradlew :feature:workform:testDebugUnitTest --tests '*WorkFormLiveTest*'
 * ```
 */
class WorkFormLiveTest {
    private val baseUrl: String? = System.getenv("OPTIO_TEST_API_URL")?.trimEnd('/')

    // One thread, like `Dispatchers.Main` in the app.
    private val executor = Executors.newSingleThreadExecutor()
    private val dispatcher = executor.asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    /** A unique suffix per run so read-backs never hit a row from an earlier run. */
    private val stamp = System.currentTimeMillis().toString(36)

    private fun named(what: String) = "Android $what $stamp"

    private val seed: JsonObject? by lazy {
        val port = baseUrl!!.substringAfterLast(':').takeWhile { it.isDigit() }
        listOfNotNull(System.getenv("OPTIO_TEST_SEED"), File(System.getProperty("user.home"), ".android/optio-devlab/test-api/$port/seed.json").path)
            .map(::File)
            .firstOrNull { it.isFile }
            ?.let { OptioJson.parseToJsonElement(it.readText()).jsonObject }
    }

    private val token: String
        get() = seed?.get("api")?.jsonObject?.get("token")?.stringValue ?: "dev"

    private val api by lazy { ApiClient(baseUrl, token) }

    @Before
    fun gate() {
        assumeTrue("OPTIO_TEST_API_URL not set", !baseUrl.isNullOrBlank())
        AgentCatalogCache.clear()
    }

    @AfterTest
    fun tearDown() {
        scope.cancel()
        executor.shutdownNow()
    }

    // region Driving the form

    private fun <T> on(block: suspend () -> T): T = runBlocking { withContext(dispatcher) { block() } }

    private fun awaitUntil(what: String, timeoutMs: Long = 15_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!on { condition() }) {
            check(System.currentTimeMillis() < deadline) { "Timed out waiting for $what" }
            Thread.sleep(20)
        }
    }

    /** A form as the screen opens it: created, loaded, the lists and the catalog in. */
    private fun form(preset: String? = null, edit: EditTarget? = null): WorkFormState {
        val state = on { WorkFormState(api, scope, presetId = preset, edit = edit).also { it.load() } }
        awaitUntil("the form's lists") {
            !state.reposLoading && !state.hostsLoading && state.workCount != null && state.catalogState is CatalogState.Loaded
        }
        return state
    }

    private fun submit(state: WorkFormState): Created =
        on { state.submit() } ?: fail("submit refused: ${on { state.error ?: "gaps ${state.gaps}" }}")

    private fun get(path: String): JsonObject = runBlocking { api.get<JsonObject>(path) }

    private fun JsonObject.obj(key: String): JsonObject = this[key]!!.jsonObject

    private fun JsonObject.str(key: String): String? = this[key]?.stringValue

    private fun triggers(path: String): List<JsonObject> = get(path).getValue("triggers").jsonArray.map { it.jsonObject }

    private fun strings(vararg values: String) = JsonArray(values.map(::JsonPrimitive))

    // endregion

    @Test
    fun repoTaskCarriesTheRuntimePromptAndTitle() {
        val state = form("pr")
        on {
            state.setRuntime("codex")
            state.setPrompt("Fix the thing [[mock:pr]]")
            state.setName(named("task"))
            assertEquals("Start work (opens a PR)", state.submitLabel)
        }
        val created = submit(state)
        val route = assertIs<TaskDetailRoute>(created.route)
        val task = get("/api/tasks/${route.id}").obj("task")
        assertEquals(named("task"), task.str("title"))
        assertEquals("codex", task.str("agentType"))
        assertEquals("Fix the thing [[mock:pr]]", task.str("prompt"))
        assertEquals("https://github.com/e2e-org/e2e-repo", task.str("repoUrl"))
        assertEquals("${named("task")} started — it will open a PR", created.toast)
    }

    @Test
    fun scheduledPodTaskSavesTheBlueprintAndItsCron() {
        val state = form("pr")
        on {
            state.setWhen(WhenType.SCHEDULE)
            state.setPrompt("Nightly sweep")
            state.setName(named("blueprint"))
        }
        val route = assertIs<ScheduledDetailRoute>(submit(state).route)
        val task = get("/api/tasks/${route.id}").obj("task")
        assertEquals("repo-blueprint", task.str("type"))
        assertEquals(named("blueprint"), task.str("name"))
        val t = triggers("/api/tasks/${route.id}/triggers").single()
        assertEquals("schedule", t.str("type"))
        assertEquals("0 9 * * *", t.obj("config").str("cronExpression"))
    }

    @Test
    fun jobWithNoRepoStartsARun() {
        val state = form("pr")
        on {
            state.setWithRepo(false)
            state.setPrompt("Say hello")
            state.setName(named("job"))
            assertEquals("Start work", state.submitLabel)
        }
        val route = assertIs<JobRunRoute>(submit(state).route)
        val workflow = get("/api/jobs/${route.jobId}").obj("workflow")
        assertEquals(named("job"), workflow.str("name"))
        assertEquals("Say hello", workflow.str("promptTemplate"))
        assertEquals(route.jobId, get("/api/tasks/${route.jobId}/runs/${route.runId}").obj("run").str("workflowId"))
    }

    @Test
    fun ticketJobKeepsItsRunName() {
        val state = form("schedule")
        on {
            state.setWhen(WhenType.TICKET)
            state.setPrompt("Triage {{ticketUrl}}")
            state.setName(named("ticket job"))
            assertTrue(state.namesRuns)
            state.setRunName("Triage: {{ticketTitle}}")
        }
        val route = assertIs<JobDetailRoute>(submit(state).route)
        val t = triggers("/api/jobs/${route.id}/triggers").single()
        assertEquals("ticket", t.str("type"))
        assertEquals("github", t.obj("config").str("source"))
        assertEquals("Triage: {{ticketTitle}}", get("/api/jobs/${route.id}").obj("workflow").str("runTitle"))
    }

    @Test
    fun persistentAgentIsNamedAndAddressable() {
        val state = form("agent")
        on {
            state.setPrompt("You are the Android e2e agent.")
            state.setName(named("agent"))
            assertEquals("Create agent", state.submitLabel)
        }
        val route = assertIs<AgentDetailRoute>(submit(state).route)
        val agent = get("/api/persistent-agents/${route.id}").obj("agent")
        assertEquals(named("agent"), agent.str("name"))
        assertEquals(slugify(named("agent")), agent.str("slug"))
    }

    @Test
    fun podSessionKeepsTheNameAndOnlyChatsWithClaudeCode() {
        val state = form("pr")
        on {
            state.setRuntime("codex")
            assertNotNull(state.thenChoices.first { it.value == Then.WAITS_FOR_ME }.disabled, "Codex can't wait for you in a pod")
            state.setRuntime("claude-code")
            state.setThen(Then.WAITS_FOR_ME)
            assertEquals(WorkKind.POD_SESSION, state.kind)
            // The first message is typed in the session: no prompt is asked for.
            assertEquals(emptyList(), state.gaps)
            state.setName(named("pod session"))
            assertEquals("Open session", state.submitLabel)
        }
        val route = assertIs<SessionDetailRoute>(submit(state).route)
        val session = get("/api/sessions/${route.id}").obj("session")
        assertEquals(named("pod session"), session.str("title"))
        assertEquals("https://github.com/e2e-org/e2e-repo", session.str("repoUrl"))
    }

    @Test
    fun localChatOnANewBranchGetsBranchInstructions() {
        val state = form("chat")
        on {
            assertEquals("E2E laptop", state.host?.name)
            state.setDir("/Users/e2e/repos/e2e-repo")
            state.setWithRepo(true)
            state.setPrompt("Rename the widget")
            state.setName(named("local chat"))
            assertEquals("Open session", state.submitLabel)
        }
        val route = assertIs<LocalTerminalRoute>(submit(state).route)
        val terminal = get("/api/local/terminals/${route.id}").obj("terminal")
        assertEquals(named("local chat"), terminal.str("title"))
        val spec = terminal.obj("spec")
        assertEquals("agent", spec.str("kind"))
        assertEquals("claude-code", spec.str("agent"))
        assertEquals("main", spec.str("baseBranch"))
        assertTrue(spec.str("prompt")!!.startsWith("Rename the widget\n\n---\n"), spec.str("prompt"))
        assertTrue("open a pull request against `main`" in spec.str("prompt")!!)
        // No daemon: it waits for the machine.
        assertEquals("pending", terminal.str("state"))
    }

    @Test
    fun linearTaskOnAMachineKeepsTheBaseBranchAndEventFilters() {
        val state = form("pr")
        on {
            state.setWhen(WhenType.LINEAR)
            // Every trigger works with every Where: the pod stays available.
            assertNull(state.podDisabled)
            state.setWhere(Where.LOCAL)
            state.setWithRepo(true)
            state.setDir("/Users/e2e/repos/e2e-repo")
            state.setPrompt("We were assigned {{ticketUrl}}. Triage it.")
            state.setName(named("linear task"))
            // "Assigned" is about you, so the login is required before submit.
            assertTrue(SentenceField.IDENTITY in state.gaps)
            assertFalse(state.canSubmit)
            state.setEventField("user", JsonPrimitive("@ada".removePrefix("@")))
            state.setEventField("teams", strings("ENG", "ops"))
            assertTrue(state.canSubmit)
        }
        // A branch that becomes a PR, on a trigger, is a scheduled Task: here one that runs in
        // the machine's checkout.
        val route = assertIs<ScheduledDetailRoute>(submit(state).route)
        val task = get("/api/tasks/${route.id}").obj("task")
        assertEquals("repo-blueprint", task.str("type"))
        assertEquals(named("linear task"), task.str("name"))
        assertEquals("claude-code", task.str("agentType"))
        assertEquals("local", task.str("runTarget"))
        assertEquals("/Users/e2e/repos/e2e-repo", task.str("localDir"))
        assertEquals("main", task.str("repoBranch"))
        assertEquals("We were assigned {{ticketUrl}}. Triage it.", task.str("prompt"))
        val t = triggers("/api/tasks/${route.id}/triggers").single()
        assertEquals("linear", t.str("type"))
        val config = t.obj("config")
        assertEquals(strings("assigned", "mentioned"), config["events"])
        assertEquals("ada", config.str("user"))
        assertEquals(strings("ENG", "ops"), config["teams"])
    }

    @Test
    fun githubTriggeredInteractiveAutomationOnAMachine() {
        val state = form("chat")
        on {
            state.setWhen(WhenType.GITHUB)
            state.setDir("/Users/e2e/repos/e2e-repo")
            state.setPrompt("Review {{url}} with me")
            state.setName(named("github automation"))
            state.setEventField("login", JsonPrimitive("octocat"))
            assertEquals(WorkKind.LOCAL_BLUEPRINT, state.kind)
            assertTrue(state.canSubmit)
        }
        val route = assertIs<LocalAutomationRoute>(submit(state).route)
        val bp = get("/api/local/blueprints").getValue("blueprints").jsonArray.map { it.jsonObject }.first { it.str("name") == named("github automation") }
        assertEquals(route.id, bp.str("id"))
        assertEquals("claude-code", bp.str("agent"))
        assertEquals("interactive", bp.str("sessionMode"))
        assertEquals("Review {{url}} with me", bp.str("commandTemplate"))
        val t = triggers("/api/local/blueprints/${route.id}/triggers").single()
        assertEquals("github", t.str("type"))
        assertEquals(strings("review_requested", "mentioned"), t.obj("config")["events"])
        assertEquals("octocat", t.obj("config").str("login"))
    }

    @Test
    fun jobInAPodSummarizesEveryOpenedPr() {
        val state = form("schedule")
        on {
            state.setWhen(WhenType.GITHUB)
            assertNull(state.podDisabled, "the pod stays the default Where; an event doesn't move it")
            state.toggleEventKind("review_requested")
            state.toggleEventKind("mentioned")
            state.toggleEventKind("pr_opened")
            state.setEventField("repos", strings("e2e-org/e2e-repo"))
            state.setPrompt("Summarize {{url}}: {{title}}")
            state.setName(named("pr summary job"))
            assertEquals("Save", state.submitLabel)
        }
        val route = assertIs<JobDetailRoute>(submit(state).route)
        val task = get("/api/tasks/${route.id}").obj("task")
        assertEquals("standalone", task.str("type"))
        assertEquals("cluster", task.str("runTarget"))
        assertEquals("Summarize {{url}}: {{title}}", task.str("promptTemplate"))
        val t = triggers("/api/tasks/${route.id}/triggers").single()
        assertEquals("github", t.str("type"))
        assertEquals(strings("pr_opened"), t.obj("config")["events"])
        assertEquals(strings("e2e-org/e2e-repo"), t.obj("config")["repos"])
    }

    @Test
    fun slackTriggerNeedsAChannelIdBeforeItWillSubmit() {
        val state = form("chat")
        on {
            state.setWhen(WhenType.SLACK)
            state.setDir("/Users/e2e/notes")
            state.setPrompt("Reply to {{permalink}}")
            assertTrue(SentenceField.CHANNEL in state.gaps)
            assertFalse(state.canSubmit)
            state.setEventField("channelId", JsonPrimitive("C0123ABCD"))
            assertTrue(state.canSubmit)
        }
    }

    @Test
    fun aRejectedTriggerRollsTheJobBack() {
        val path = seed?.get("jobs")?.jsonObject?.get("webhook")?.jsonObject?.str("webhookPath")
        assumeTrue("no seeded webhook path", path != null)
        val state = form("schedule")
        on {
            state.setWhen(WhenType.WEBHOOK)
            state.setWebhookPath(path!!)
            state.setPrompt("Duplicate hook")
            state.setName(named("duplicate hook job"))
        }
        assertNull(on { state.submit() })
        assertTrue(on { state.error }!!.contains("already in use"), on { state.error })
        val names = get("/api/jobs").getValue("workflows").jsonArray.map { it.jsonObject.str("name") }
        assertFalse(named("duplicate hook job") in names, "the half-made Job was deleted")
    }

    @Test
    fun twoUnnamedJobsFromTheSameCountGetBumpedNames() {
        fun unnamed(): WorkFormState = form("schedule").also { s -> on { s.setPrompt("Unnamed $stamp") } }
        val first = unnamed()
        val second = unnamed()
        assertEquals(on { first.autoName }, on { second.autoName })
        val a = assertIs<JobDetailRoute>(submit(first).route)
        val b = assertIs<JobDetailRoute>(submit(second).route)
        val nameA = get("/api/jobs/${a.id}").obj("workflow").str("name")!!
        val nameB = get("/api/jobs/${b.id}").obj("workflow").str("name")!!
        val auto = on { second.autoName }
        assertTrue(nameA.startsWith(auto), nameA)
        // Names are unique per workspace; with auth disabled there is no workspace (NULL is never a
        // duplicate), so the server takes the same name twice. Run against `--auth` to see the bump.
        assumeTrue("the server accepts duplicate names (auth disabled: no workspace)", nameA != nameB)
        assertTrue(nameB.startsWith("$auto ("), nameB)
        assertTrue(nameA != nameB)
    }

    // region Editing recurring work

    @Test
    fun aJobKeepsItsKindAndSavesPromptAndSchedule() {
        val id = runBlocking {
            api.createTaskUnified(
                jsonObjectOf(
                    "type" to JsonPrimitive("standalone"),
                    "name" to JsonPrimitive(named("editable job")),
                    "title" to JsonPrimitive(named("editable job")),
                    "prompt" to JsonPrimitive("Before"),
                    "agentType" to JsonPrimitive("claude-code"),
                    "enabled" to JsonPrimitive(true),
                ),
            ).also { api.createTaskTrigger(it, TriggerSpec("schedule", jsonObjectOf("cronExpression" to JsonPrimitive("0 9 * * *"))).body) }
        }
        val before = triggers("/api/tasks/$id/triggers").single()
        val target = runBlocking { loadEditTarget(api, id) }
        assertEquals(EditableKind.STANDALONE, target.kind)
        val state = form(edit = target)
        on {
            // Prefilled from the row.
            assertEquals("Before", state.draft.prompt)
            assertEquals("0 9 * * *", state.draft.trigger.cronExpression)
            assertEquals(named("editable job"), state.draft.name)
            // The kind is locked: a repo would make it a scheduled Task.
            assertTrue(state.withRepoDisabled(true)!!.contains("saved as a Job"))
            // …but its own attributes are open.
            assertNull(state.whenDisabled(WhenType.WEBHOOK))
            state.setPrompt("After")
            state.setCron("0 * * * *")
            assertEquals("Save changes", state.submitLabel)
        }
        val saved = submit(state)
        assertEquals(JobDetailRoute(id), saved.route)
        assertEquals("After", get("/api/tasks/$id").obj("task").str("promptTemplate"))
        val after = triggers("/api/tasks/$id/triggers").single()
        assertEquals("schedule", after.str("type"))
        assertEquals("0 * * * *", after.obj("config").str("cronExpression"))
        assertEquals(before.str("id"), after.str("id"), "the same trigger, patched in place")
    }

    @Test
    fun aLocalAutomationIsEditedInTheFormToo() {
        val hostId = get("/api/local/hosts").getValue("hosts").jsonArray.first().jsonObject.str("id")!!
        val id = runBlocking {
            api.createLocalBlueprint(
                jsonObjectOf(
                    "name" to JsonPrimitive(named("editable automation")),
                    "hostId" to JsonPrimitive(hostId),
                    "dir" to JsonPrimitive("/Users/e2e/notes"),
                    "commandTemplate" to JsonPrimitive("Reply to {{permalink}}"),
                    "agent" to JsonPrimitive("claude-code"),
                    "sessionMode" to JsonPrimitive("interactive"),
                ),
            ).also {
                api.createLocalBlueprintTrigger(
                    it,
                    TriggerSpec("slack", jsonObjectOf("channelId" to JsonPrimitive("C0123ABCD"), "mentionOnly" to JsonPrimitive(true))).body,
                )
            }
        }
        val target = runBlocking { loadEditTarget(api, id) }
        assertEquals(EditableKind.LOCAL_BLUEPRINT, target.kind)
        val state = form(edit = target)
        on {
            assertEquals("C0123ABCD", state.draft.event.config.string("channelId"))
            assertEquals("Reply to {{permalink}}", state.draft.prompt)
            assertEquals(WorkKind.LOCAL_BLUEPRINT, state.kind)
            state.setEventField("channelId", JsonPrimitive("C0999ZZZZ"))
            state.setName(named("renamed automation"))
        }
        val saved = submit(state)
        assertEquals(LocalAutomationRoute(id), saved.route)
        assertEquals(named("renamed automation"), get("/api/local/blueprints/$id").obj("blueprint").str("name"))
        val t = triggers("/api/local/blueprints/$id/triggers").single()
        assertEquals("C0999ZZZZ", t.obj("config").str("channelId"))
        assertEquals(JsonPrimitive(true), t.obj("config")["mentionOnly"])
    }

    // endregion
}
