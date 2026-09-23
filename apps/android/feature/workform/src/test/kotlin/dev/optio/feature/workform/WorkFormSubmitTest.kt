package dev.optio.feature.workform

import dev.optio.core.model.OptioJson
import dev.optio.core.navigation.routes.AgentDetailRoute
import dev.optio.core.navigation.routes.JobDetailRoute
import dev.optio.core.navigation.routes.JobRunRoute
import dev.optio.core.navigation.routes.LocalAutomationRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.navigation.routes.ScheduledDetailRoute
import dev.optio.core.navigation.routes.SessionDetailRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.network.ApiError
import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Before
import org.junit.Rule
import org.junit.Test

/**
 * The submit layer against a fake API: the exact body each kind sends, and the vectors of
 * `apps/web/src/components/work-form/submit.test.ts` (name-clash retry, run names, rollback,
 * `updateWork`'s trigger sync).
 */
class WorkFormSubmitTest {
    @get:Rule
    val rule = FakeOptioServerRule()

    private val server: FakeOptioServer
        get() = rule.server

    private fun obj(json: String): JsonObject = OptioJson.parseToJsonElement(json).jsonObject

    private fun body(method: String, path: String): JsonObject = server.lastRequest(method, path)!!.json.jsonObject

    private val submitter by lazy { WorkFormSubmitter(server.client()) }

    private val hostId = "30194174-0c57-4aa9-9ebd-cbe321d09172"

    private fun local(d: WorkDraft, dir: String = "/Users/e2e/repos/e2e-repo") =
        d.copy(location = d.location.copy(runTarget = Where.LOCAL, localHostId = hostId, localDir = dir))

    @Before
    fun routes() {
        server.post("/api/tasks") { FakeResponse.json("""{"task":{"id":"t-1","type":"x"}}""", 201) }
        server.post("/api/tasks/:id/triggers") { FakeResponse.json("""{"trigger":{"id":"trg-1"}}""", 201) }
        server.post("/api/tasks/:id/runs") { FakeResponse.json("""{"runId":"run-1","type":"workflow-run"}""", 202) }
        server.post("/api/local/blueprints") { FakeResponse.json("""{"blueprint":{"id":"b-1"}}""", 201) }
        server.post("/api/local/blueprints/:id/triggers") { FakeResponse.json("""{"trigger":{"id":"trg-2"}}""", 201) }
        server.post("/api/local/terminals") { FakeResponse.json("""{"terminal":{"id":"lt-1"}}""", 201) }
        server.post("/api/sessions") { FakeResponse.json("""{"session":{"id":"s-1"}}""", 201) }
        server.post("/api/persistent-agents") { FakeResponse.json("""{"agent":{"id":"a-1"}}""", 201) }
        server.post("/api/persistent-agents/:id/triggers") { FakeResponse.json("""{"trigger":{"id":"trg-3"}}""", 201) }
        for (path in listOf("/api/jobs/:id", "/api/task-configs/:id", "/api/local/blueprints/:id", "/api/persistent-agents/:id")) {
            server.delete(path) { FakeResponse.empty() }
        }
    }

    // region Bodies per kind

    @Test
    fun repoTaskSendsTheUnifiedBodyWithMetadataOptionsAndDependencies() = runTest {
        val d = normalize(
            WorkDraft.EMPTY.copy(
                repoId = "r1",
                repoUrl = "https://github.com/e2e-org/e2e-repo",
                runtime = "codex",
                agentOptions = mapOf("copilotModel" to OptionValue.Str("gpt-5"), "codexReasoning" to OptionValue.Str("")),
                prompt = "  Fix the thing [[mock:pr]]\n",
                description = "Why",
                dependsOn = listOf("dep-1"),
            ),
        )
        val created = submitter.create(d, "https://github.com/e2e-org/e2e-repo", autoName = "Task 14")
        assertEquals(Created(WorkKind.REPO_TASK, TaskDetailRoute("t-1"), "Task 14 started — it will open a PR"), created)
        assertEquals(
            obj(
                """{"type":"repo-task","title":"Task 14","prompt":"Fix the thing [[mock:pr]]","description":"Why","agentType":"codex",
                "maxRetries":3,"priority":100,"repoUrl":"https://github.com/e2e-org/e2e-repo","repoBranch":"main",
                "metadata":{"agentOptions":{"copilotModel":"gpt-5"}},"dependsOn":["dep-1"],
                "runTarget":"cluster","localHostId":null,"localDir":null,"localSessionMode":null}""",
            ),
            body("POST", "/api/tasks"),
        )
    }

    @Test
    fun repoTaskOnAMachineSendsTheLocation() = runTest {
        val d = normalize(local(WorkDraft.EMPTY.copy(prompt = "p", name = "Mine")))
        submitter.create(d, "https://github.com/e2e-org/e2e-repo", autoName = "Task 1")
        val b = body("POST", "/api/tasks")
        assertEquals(obj("""{"runTarget":"local","localHostId":"$hostId","localDir":"/Users/e2e/repos/e2e-repo","localSessionMode":"headless"}"""), JsonObject(b.filterKeys { it.startsWith("runTarget") || it.startsWith("local") }))
        assertEquals(false, "metadata" in b)
        assertEquals(false, "description" in b)
        assertEquals(false, "dependsOn" in b)
    }

    @Test
    fun repoBlueprintSavesTheRowThenItsScheduleTrigger() = runTest {
        val d = normalize(
            WorkDraft.EMPTY.copy(
                repoUrl = "https://github.com/e2e-org/e2e-repo",
                repoBranch = "develop",
                whenType = WhenType.SCHEDULE,
                trigger = TriggerConfig(TriggerType.SCHEDULE, cronExpression = "0 9 * * *"),
                prompt = "Nightly sweep",
                name = "Sweep",
                priority = 7,
            ),
        )
        val created = submitter.create(d, "https://github.com/e2e-org/e2e-repo", autoName = "Task 3")
        assertEquals(Created(WorkKind.REPO_BLUEPRINT, ScheduledDetailRoute("t-1"), "Sweep saved"), created)
        assertEquals(
            obj(
                """{"type":"repo-blueprint","title":"Sweep","name":"Sweep","prompt":"Nightly sweep","agentType":"claude-code",
                "agentOptions":null,"maxRetries":3,"priority":7,"repoUrl":"https://github.com/e2e-org/e2e-repo","repoBranch":"develop",
                "enabled":true,"runTarget":"cluster","localHostId":null,"localDir":null,"localSessionMode":null}""",
            ),
            body("POST", "/api/tasks"),
        )
        assertEquals(
            obj("""{"type":"schedule","config":{"cronExpression":"0 9 * * *"},"enabled":true}"""),
            body("POST", "/api/tasks/t-1/triggers"),
        )
    }

    @Test
    fun jobNowCreatesTheRowThenStartsARun() = runTest {
        val d = normalize(
            WorkDraft.EMPTY.copy(
                withRepo = false,
                prompt = "Say hello",
                name = "Hello",
                agentOptions = mapOf("claudeModel" to OptionValue.Str("opus"), "claudeThinking" to OptionValue.Bool(true)),
            ),
        )
        val created = submitter.create(d, "", autoName = "Job 2")
        assertEquals(Created(WorkKind.STANDALONE, JobRunRoute("t-1", "run-1"), "Hello started"), created)
        assertEquals(
            obj(
                """{"type":"standalone","title":"Hello","name":"Hello","prompt":"Say hello","agentType":"claude-code","model":"opus",
                "agentOptions":{"claudeModel":"opus","claudeThinking":true},"maxRetries":3,"enabled":true,
                "runTarget":"cluster","localHostId":null,"localDir":null,"localSessionMode":null}""",
            ),
            body("POST", "/api/tasks"),
        )
        assertEquals(obj("""{"params":{}}"""), body("POST", "/api/tasks/t-1/runs"))
        assertEquals(0, server.count("POST", "/api/tasks/t-1/triggers"))
    }

    @Test
    fun triggeredJobSendsItsRunNameAndEventTrigger() = runTest {
        val d = normalize(
            WorkDraft.EMPTY.copy(
                name = "Linear triage",
                runName = "  Triage: {{ticketTitle}} ",
                withRepo = false,
                prompt = "Triage {{ticketUrl}}",
                whenType = WhenType.LINEAR,
                event = EventTrigger(EventTriggerType.LINEAR, obj("""{"events":["mentioned"],"user":"jon","teams":["ENG"]}""")),
            ),
        )
        val created = submitter.create(d, "", autoName = "Job 1")
        assertEquals(Created(WorkKind.STANDALONE, JobDetailRoute("t-1"), "Linear triage saved"), created)
        val b = body("POST", "/api/tasks")
        assertEquals("standalone", b.text("type"))
        assertEquals("Linear triage", b.text("name"))
        assertEquals("Triage: {{ticketTitle}}", b.text("runTitle"))
        assertEquals(
            obj("""{"type":"linear","config":{"events":["mentioned"],"user":"jon","teams":["ENG"]},"enabled":true}"""),
            body("POST", "/api/tasks/t-1/triggers"),
        )
        assertEquals(0, server.count("POST", "/api/tasks/t-1/runs"))
    }

    @Test
    fun runNameIsTheBlueprintTitleForAScheduledTask() = runTest {
        val d = normalize(
            WorkDraft.EMPTY.copy(
                name = "Linear triage",
                runName = "Triage: {{ticketTitle}}",
                repoUrl = "https://github.com/a/b",
                prompt = "Triage {{ticketUrl}}",
                whenType = WhenType.LINEAR,
                event = EventTrigger(EventTriggerType.LINEAR, obj("""{"events":["mentioned"],"user":"jon"}""")),
            ),
        )
        submitter.create(d, "https://github.com/a/b", autoName = "Task 1")
        val b = body("POST", "/api/tasks")
        assertEquals("repo-blueprint", b.text("type"))
        assertEquals("Linear triage", b.text("name"))
        assertEquals("Triage: {{ticketTitle}}", b.text("title"))
    }

    @Test
    fun localAutomationSendsBranchSessionModeAndTrigger() = runTest {
        val d = normalize(
            local(
                WorkDraft.EMPTY.copy(
                    whenType = WhenType.GITHUB,
                    event = EventTrigger(EventTriggerType.GITHUB, obj("""{"events":["review_requested","mentioned"],"login":"octocat"}""")),
                    withRepo = true,
                    repoBranch = "",
                    prompt = "Review {{url}} with me",
                    runName = "Review: {{title}}",
                    then = Then.WAITS_FOR_ME,
                    name = "GitHub automation",
                ),
            ),
        )
        val created = submitter.create(d, "https://github.com/e2e-org/e2e-repo", autoName = "Automation 1")
        assertEquals(Created(WorkKind.LOCAL_BLUEPRINT, LocalAutomationRoute("b-1"), "GitHub automation saved"), created)
        assertEquals(
            obj(
                """{"name":"GitHub automation","hostId":"$hostId","dir":"/Users/e2e/repos/e2e-repo",
                "repoUrl":"https://github.com/e2e-org/e2e-repo","baseBranch":"main","commandTemplate":"Review {{url}} with me",
                "runTitle":"Review: {{title}}","agent":"claude-code","spawnMode":"auto","sessionMode":"interactive"}""",
            ),
            body("POST", "/api/local/blueprints"),
        )
        assertEquals(
            obj("""{"type":"github","config":{"events":["review_requested","mentioned"],"login":"octocat"},"enabled":true}"""),
            body("POST", "/api/local/blueprints/b-1/triggers"),
        )
    }

    @Test
    fun localAgentTerminalOnANewBranchCarriesTheBaseBranchAndModel() = runTest {
        val d = normalize(
            local(
                WorkDraft.EMPTY.copy(
                    then = Then.WAITS_FOR_ME,
                    withRepo = true,
                    prompt = "Rename the widget",
                    name = "Local chat",
                    agentOptions = mapOf("claudeModel" to OptionValue.Str("sonnet")),
                ),
            ),
        )
        val created = submitter.create(d, "https://github.com/e2e-org/e2e-repo", autoName = "Terminal 1")
        assertEquals(Created(WorkKind.LOCAL_TERMINAL, LocalTerminalRoute("lt-1"), "Local chat opened"), created)
        assertEquals(
            obj(
                """{"hostId":"$hostId","dir":"/Users/e2e/repos/e2e-repo","title":"Local chat",
                "spec":{"kind":"agent","agent":"claude-code","prompt":"Rename the widget","model":"sonnet","baseBranch":"main"}}""",
            ),
            body("POST", "/api/local/terminals"),
        )
    }

    @Test
    fun localShellTerminalIsJustAShell() = runTest {
        val d = normalize(local(preset("terminal")!!.apply(WorkDraft.EMPTY), dir = "/Users/e2e/notes"))
        val created = submitter.create(d, "", autoName = "Terminal 5")
        assertEquals(Created(WorkKind.LOCAL_TERMINAL, LocalTerminalRoute("lt-1"), "Terminal 5 opened"), created)
        assertEquals(
            obj("""{"hostId":"$hostId","dir":"/Users/e2e/notes","title":"Terminal 5","spec":{"kind":"shell"}}"""),
            body("POST", "/api/local/terminals"),
        )
    }

    @Test
    fun podSessionSendsOnlyTheRepoAndTheName() = runTest {
        val d = normalize(WorkDraft.EMPTY.copy(then = Then.WAITS_FOR_ME, repoUrl = "https://github.com/e2e-org/e2e-repo", prompt = "ignored"))
        val created = submitter.create(d, "https://github.com/e2e-org/e2e-repo", autoName = "Session 9")
        assertEquals(Created(WorkKind.POD_SESSION, SessionDetailRoute("s-1"), "Session 9 opened"), created)
        assertEquals(obj("""{"repoUrl":"https://github.com/e2e-org/e2e-repo","title":"Session 9"}"""), body("POST", "/api/sessions"))
    }

    @Test
    fun persistentAgentGetsASlugTheStandardManualAndItsTrigger() = runTest {
        val d = normalize(
            preset("agent")!!.apply(WorkDraft.EMPTY).copy(
                prompt = "You are the e2e agent.",
                name = "Release Captain 2",
                whenType = WhenType.SCHEDULE,
                trigger = TriggerConfig(TriggerType.SCHEDULE, cronExpression = "0 * * * *"),
                agent = AgentExtras(podLifecycle = PodLifecycle.ON_DEMAND),
            ),
        )
        val created = submitter.create(d, "", autoName = "Agent 1")
        assertEquals(Created(WorkKind.PERSISTENT_AGENT, AgentDetailRoute("a-1"), "Release Captain 2 created"), created)
        val expected = obj(
            """{"slug":"release-captain-2","name":"Release Captain 2","agentRuntime":"claude-code","model":null,"agentOptions":null,
            "systemPrompt":null,"agentsMd":"","initialPrompt":"You are the e2e agent.","podLifecycle":"on-demand"}""",
        )
        val b = body("POST", "/api/persistent-agents")
        assertEquals(JsonObject(expected.filterKeys { it != "agentsMd" }), JsonObject(b.filterKeys { it != "agentsMd" }))
        assertEquals(DEFAULT_AGENTS_MD, b.text("agentsMd"))
        assertTrue(DEFAULT_AGENTS_MD.startsWith("You are running as a Persistent Agent inside Optio."))
        assertTrue(DEFAULT_AGENTS_MD.endsWith("scheduled tick.\n"))
        assertTrue("\"\$OPTIO_API_URL/api/internal/persistent-agents\"" in DEFAULT_AGENTS_MD)
        assertEquals(
            obj("""{"type":"schedule","config":{"cronExpression":"0 * * * *"},"enabled":true}"""),
            body("POST", "/api/persistent-agents/a-1/triggers"),
        )
    }

    @Test
    fun persistentAgentKeepsATypedSlugSystemPromptAndManual() = runTest {
        val d = normalize(
            preset("agent")!!.apply(WorkDraft.EMPTY).copy(
                prompt = "Go",
                agent = AgentExtras(slug = "captain", systemPrompt = "You ship releases.", agentsMd = "# Manual"),
            ),
        )
        submitter.create(d, "", autoName = "Agent 3")
        val b = body("POST", "/api/persistent-agents")
        assertEquals("captain", b.text("slug"))
        assertEquals("Agent 3", b.text("name"))
        assertEquals("You ship releases.", b.text("systemPrompt"))
        assertEquals("# Manual", b.text("agentsMd"))
        assertEquals(0, server.count("POST", "/api/persistent-agents/a-1/triggers"))
    }

    // endregion

    // region submit.test.ts: createWork

    @Test
    fun bumpsAnAutomaticNameOnA409AndKeepsTheUsersOwnNameAsAnError() = runTest {
        val job = normalize(
            WorkDraft.EMPTY.copy(
                withRepo = false,
                prompt = "hi",
                whenType = WhenType.SCHEDULE,
                trigger = TriggerConfig(TriggerType.SCHEDULE, cronExpression = "0 9 * * *"),
            ),
        )
        val calls = AtomicInteger()
        server.post("/api/tasks") {
            if (calls.getAndIncrement() == 0) {
                FakeResponse.error(409, "A Job named \"Session 4\" already exists")
            } else {
                FakeResponse.json("""{"task":{"id":"w-1"}}""", 201)
            }
        }
        val created = submitter.create(job, "", autoName = "Session 4")
        assertEquals(JobDetailRoute("w-1"), created.route)
        val creates = server.requests("POST", "/api/tasks")
        assertEquals(2, creates.size)
        assertEquals("Session 4", creates[0].json.jsonObject.text("name"))
        assertEquals("Session 4 (2)", creates[1].json.jsonObject.text("name"))

        server.clearRequests()
        server.error("POST", "/api/tasks", 409, "A Job named \"Nightly\" already exists")
        val e = assertFailsWith<ApiError> { submitter.create(job.copy(name = "Nightly"), "", autoName = "Session 4") }
        assertTrue("already exists" in e.message)
        assertEquals(1, server.count("POST", "/api/tasks"))
    }

    @Test
    fun givesUpAfterFiveAutomaticNames() = runTest {
        server.error("POST", "/api/tasks", 409, "A Job named \"x\" already exists")
        val job = normalize(WorkDraft.EMPTY.copy(withRepo = false, prompt = "hi"))
        assertFailsWith<ApiError> { submitter.create(job, "", autoName = "Job 1") }
        assertEquals(
            listOf("Job 1", "Job 1 (2)", "Job 1 (3)", "Job 1 (4)", "Job 1 (5)"),
            server.requests("POST", "/api/tasks").map { it.json.jsonObject.text("name") },
        )
    }

    @Test
    fun rollsAJobBackWhenItsTriggerIsRejected() = runTest {
        val job = normalize(
            WorkDraft.EMPTY.copy(
                withRepo = false,
                prompt = "hi",
                whenType = WhenType.WEBHOOK,
                trigger = TriggerConfig(TriggerType.WEBHOOK, webhookPath = "hook-1"),
            ),
        )
        server.post("/api/tasks") { FakeResponse.json("""{"task":{"id":"w-2"}}""", 201) }
        server.error("POST", "/api/tasks/w-2/triggers", 409, "Webhook path \"hook-1\" is already in use")
        val e = assertFailsWith<ApiError> { submitter.create(job, "", autoName = "Session 1") }
        assertTrue("Webhook path" in e.message)
        assertEquals(1, server.count("DELETE", "/api/jobs/w-2"))
        // A trigger 409 is not a name clash: no retry loop.
        assertEquals(1, server.count("POST", "/api/tasks"))
    }

    @Test
    fun rollsEveryBlueprintKindBackThroughItsOwnDelete() = runTest {
        server.error("POST", "/api/tasks/t-1/triggers", 400, "Schedule triggers require config.cronExpression")
        server.error("POST", "/api/local/blueprints/b-1/triggers", 400, "Slack triggers require config.channelId (e.g. C0123ABCD)")
        server.error("POST", "/api/persistent-agents/a-1/triggers", 400, "bad trigger")

        val blueprint = normalize(
            WorkDraft.EMPTY.copy(repoUrl = "https://github.com/a/b", prompt = "p", whenType = WhenType.SCHEDULE, trigger = TriggerConfig(TriggerType.SCHEDULE, cronExpression = "0 9 * * *")),
        )
        assertFailsWith<ApiError> { submitter.create(blueprint, "https://github.com/a/b", "Task 1") }
        assertEquals(1, server.count("DELETE", "/api/task-configs/t-1"))

        val automation = normalize(
            local(
                WorkDraft.EMPTY.copy(
                    withRepo = false,
                    then = Then.WAITS_FOR_ME,
                    whenType = WhenType.SLACK,
                    event = EventTrigger(EventTriggerType.SLACK, obj("""{"channelId":"C0123ABCD","mentionOnly":false}""")),
                    prompt = "Reply",
                ),
                dir = "/Users/e2e/notes",
            ),
        )
        val e = assertFailsWith<ApiError> { submitter.create(automation, "", "Automation 1") }
        assertTrue("channelId" in e.message)
        assertEquals(1, server.count("DELETE", "/api/local/blueprints/b-1"))

        val agent = normalize(
            preset("agent")!!.apply(WorkDraft.EMPTY).copy(prompt = "p", whenType = WhenType.WEBHOOK, trigger = TriggerConfig(TriggerType.WEBHOOK, webhookPath = "hook-2")),
        )
        assertFailsWith<ApiError> { submitter.create(agent, "", "Agent 1") }
        assertEquals(1, server.count("DELETE", "/api/persistent-agents/a-1"))
    }

    @Test
    fun aRejectedFirstRunIsNotANameClash() = runTest {
        server.error("POST", "/api/tasks/t-1/runs", 409, "Job is disabled")
        val job = normalize(WorkDraft.EMPTY.copy(withRepo = false, prompt = "hi"))
        val e = assertFailsWith<ApiError> { submitter.create(job, "", autoName = "Job 1") }
        assertEquals(409, e.status)
        assertEquals(1, server.count("POST", "/api/tasks"))
    }

    // endregion

    // region submit.test.ts: updateWork

    private val editedJob = normalize(
        WorkDraft.EMPTY.copy(
            name = "Digest",
            withRepo = false,
            prompt = "Summarize",
            whenType = WhenType.SCHEDULE,
            trigger = TriggerConfig(TriggerType.SCHEDULE, cronExpression = "0 9 * * *"),
        ),
    )

    private fun target(trigger: JsonObject?, kind: EditableKind = EditableKind.STANDALONE, id: String = "w-1", draft: WorkDraft = editedJob) =
        EditTarget(id, kind, obj("""{"id":"$id","name":"Digest"}"""), trigger, listOfNotNull(trigger), draft)

    private fun editRoutes() {
        server.patch("/api/jobs/:id") { FakeResponse.json("""{"workflow":{}}""") }
        server.patch("/api/task-configs/:id") { FakeResponse.json("""{"taskConfig":{}}""") }
        server.patch("/api/local/blueprints/:id") { FakeResponse.json("""{"blueprint":{}}""") }
        server.patch("/api/tasks/:id/triggers/:tid") { FakeResponse.json("""{"trigger":{}}""") }
        server.patch("/api/local/blueprints/:id/triggers/:tid") { FakeResponse.json("""{"trigger":{}}""") }
        server.delete("/api/tasks/:id/triggers/:tid") { FakeResponse.empty() }
        server.delete("/api/local/blueprints/:id/triggers/:tid") { FakeResponse.empty() }
    }

    @Test
    fun patchesTheRowAndForTheSameTriggerTypeTheTriggerInPlace() = runTest {
        editRoutes()
        val t = target(obj("""{"id":"t1","type":"schedule","config":{"cronExpression":"0 8 * * *"}}"""))
        val saved = submitter.update(t, editedJob, repoUrl = "")
        assertEquals(
            obj(
                """{"name":"Digest","runTitle":null,"promptTemplate":"Summarize","description":"","agentRuntime":"claude-code",
                "model":null,"agentOptions":null,"maxRetries":3,"runTarget":"cluster","localHostId":null,"localDir":null,"localSessionMode":null}""",
            ),
            body("PATCH", "/api/jobs/w-1"),
        )
        assertEquals(obj("""{"config":{"cronExpression":"0 9 * * *"}}"""), body("PATCH", "/api/tasks/w-1/triggers/t1"))
        assertEquals(0, server.count("POST", "/api/tasks/w-1/triggers"))
        assertEquals(0, server.count("DELETE", "/api/tasks/w-1/triggers/t1"))
        assertEquals(Created(WorkKind.STANDALONE, JobDetailRoute("w-1"), "Digest saved"), saved)
    }

    @Test
    fun createsTheNewTriggerBeforeRetiringTheOldOneWhenTheTypeChanges() = runTest {
        editRoutes()
        val t = target(obj("""{"id":"t1","type":"webhook","config":{"path":"hook-1"}}"""))
        submitter.update(t, editedJob, repoUrl = "")
        assertEquals(obj("""{"type":"schedule","config":{"cronExpression":"0 9 * * *"},"enabled":true}"""), body("POST", "/api/tasks/w-1/triggers"))
        val order = server.requests.filter { it.path.startsWith("/api/tasks/w-1/triggers") }.map { it.method }
        assertEquals(listOf("POST", "DELETE"), order)
        assertEquals(1, server.count("DELETE", "/api/tasks/w-1/triggers/t1"))
    }

    @Test
    fun keepsTheRowWhenAReplacementTriggerIsRejected() = runTest {
        editRoutes()
        server.error("POST", "/api/tasks/w-1/triggers", 400, "bad cron")
        val t = target(obj("""{"id":"t1","type":"webhook","config":{"path":"hook-1"}}"""))
        val e = assertFailsWith<ApiError> { submitter.update(t, editedJob, repoUrl = "") }
        assertTrue("bad cron" in e.message)
        assertEquals(0, server.count("DELETE", "/api/tasks/w-1/triggers/t1"))
        assertEquals(0, server.count("DELETE", "/api/jobs/w-1"))
    }

    @Test
    fun removesTheLoadedTriggerWhenTheEditGoesBackToNow() = runTest {
        editRoutes()
        val t = target(obj("""{"id":"t1","type":"schedule","config":{"cronExpression":"0 9 * * *"}}"""))
        submitter.update(t, editedJob.copy(whenType = WhenType.MANUAL, trigger = TriggerConfig.MANUAL), repoUrl = "")
        assertEquals(1, server.count("DELETE", "/api/tasks/w-1/triggers/t1"))
        assertEquals(0, server.count("POST", "/api/tasks/w-1/triggers"))
    }

    @Test
    fun savesALocalAutomationsEventTriggerAndBaseBranch() = runTest {
        editRoutes()
        val auto = normalize(
            WorkDraft.EMPTY.copy(
                name = "Reviews",
                whenType = WhenType.GITHUB,
                trigger = TriggerConfig.MANUAL,
                event = EventTrigger(EventTriggerType.GITHUB, obj("""{"events":["mentioned"],"login":"octocat"}""")),
                location = RunLocation(Where.LOCAL, "h1", "/Users/dev/repos/app", LocalSessionMode.INTERACTIVE),
                withRepo = true,
                repoBranch = "main",
                prompt = "Look at {{url}}",
                then = Then.WAITS_FOR_ME,
            ),
        )
        val t = target(obj("""{"id":"t1","type":"linear","config":{}}"""), EditableKind.LOCAL_BLUEPRINT, id = "b-1", draft = auto)
        val saved = submitter.update(t, auto, repoUrl = "https://github.com/acme/app")
        assertEquals(
            obj(
                """{"name":"Reviews","description":null,"hostId":"h1","dir":"/Users/dev/repos/app","repoUrl":"https://github.com/acme/app",
                "baseBranch":"main","commandTemplate":"Look at {{url}}","runTitle":null,"agent":"claude-code","sessionMode":"interactive"}""",
            ),
            body("PATCH", "/api/local/blueprints/b-1"),
        )
        assertEquals(
            obj("""{"type":"github","config":{"events":["mentioned"],"login":"octocat"},"enabled":true}"""),
            body("POST", "/api/local/blueprints/b-1/triggers"),
        )
        assertEquals(1, server.count("DELETE", "/api/local/blueprints/b-1/triggers/t1"))
        assertEquals(Created(WorkKind.LOCAL_BLUEPRINT, LocalAutomationRoute("b-1"), "Reviews saved"), saved)
    }

    @Test
    fun savesAScheduledTaskWithItsRunNameAsTheTitle() = runTest {
        editRoutes()
        val d = normalize(
            WorkDraft.EMPTY.copy(
                name = "",
                runName = "Nightly: {{title}}",
                repoUrl = "https://github.com/a/b",
                prompt = "Sweep",
                whenType = WhenType.SCHEDULE,
                trigger = TriggerConfig(TriggerType.SCHEDULE, cronExpression = "0 9 * * *"),
            ),
        )
        val t = EditTarget("c-1", EditableKind.REPO_BLUEPRINT, obj("""{"id":"c-1","name":"Nightly sweep"}"""), null, emptyList(), d)
        val saved = submitter.update(t, d, repoUrl = "https://github.com/a/b")
        val b = body("PATCH", "/api/task-configs/c-1")
        // A blank name keeps the saved one.
        assertEquals("Nightly sweep", b.text("name"))
        assertEquals("Nightly: {{title}}", b.text("title"))
        assertEquals("https://github.com/a/b", b.text("repoUrl"))
        assertEquals(obj("""{"type":"schedule","config":{"cronExpression":"0 9 * * *"},"enabled":true}"""), body("POST", "/api/tasks/c-1/triggers"))
        assertEquals(Created(WorkKind.REPO_BLUEPRINT, ScheduledDetailRoute("c-1"), "Nightly sweep saved"), saved)
    }

    // endregion
}
