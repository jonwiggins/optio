package dev.optio.core.workfeed

import dev.optio.core.model.OptioJson
import dev.optio.core.navigation.WorkView
import dev.optio.core.navigation.routes.AgentDetailRoute
import dev.optio.core.navigation.routes.JobDetailRoute
import dev.optio.core.navigation.routes.JobRunRoute
import dev.optio.core.navigation.routes.LocalAutomationRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.navigation.routes.ScheduledDetailRoute
import dev.optio.core.navigation.routes.SessionDetailRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.workfeed.WorkFeed.AgentRow
import dev.optio.core.workfeed.WorkFeed.BlueprintRow
import dev.optio.core.workfeed.WorkFeed.HostRow
import dev.optio.core.workfeed.WorkFeed.PodSessionRow
import dev.optio.core.workfeed.WorkFeed.Sources
import dev.optio.core.workfeed.WorkFeed.TerminalRow
import dev.optio.core.workfeed.WorkFeed.UnifiedRow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Mirrors iOS `OptioTests/WorkFeedTests.swift` and the web's `lib/work-feed.test.ts`: the Kotlin
 * port must project every source onto the same rows, in the same order, with the same counts.
 */
class WorkFeedTest {
    private fun spec(
        kind: String,
        agent: String? = null,
        mode: String? = null,
    ): JsonObject = buildJsonObject {
        put("kind", kind)
        agent?.let { put("agent", it) }
        mode?.let { put("mode", it) }
    }

    /** The fixture both iOS and the web test with. */
    private fun sources() = Sources(
        unified = listOf(
            UnifiedRow(
                type = "repo-task", id = "t1", title = "Fix bug", state = "completed",
                repoUrl = "https://github.com/acme/app", agentType = "codex",
                prUrl = "https://github.com/acme/app/pull/7", updatedAt = "2026-09-01T00:00:00Z",
            ),
            UnifiedRow(
                type = "repo-task", id = "t2", title = "Needs me", state = "needs_attention",
                runTarget = "local", localHostId = "h1", localDir = "/Users/dev/app",
                updatedAt = "2026-08-01T00:00:00Z",
            ),
            UnifiedRow(type = "repo-blueprint", id = "b1", name = "Nightly", enabled = true, repoUrl = "x"),
            UnifiedRow(type = "standalone", id = "j1", name = "Report", enabled = false, agentRuntime = "gemini"),
        ),
        localTerminals = listOf(
            TerminalRow(
                id = "lt1", title = "shell", state = "running", attentionState = "needs_you",
                hostId = "h1", dir = "/Users/dev/notes", spec = spec("shell"),
                spawnedBy = "manual", lastActivityAt = "2026-09-02T00:00:00Z",
            ),
            TerminalRow(id = "lt2", title = "dup", state = "running", spec = spec("agent", agent = "claude-code"), taskId = "t2"),
        ),
        localBlueprints = listOf(BlueprintRow(id = "a1", name = "Review PRs", agent = "claude-code", hostId = "h1", enabled = true)),
        podSessions = listOf(PodSessionRow(id = "s1", repoUrl = "https://github.com/acme/app", branch = "session/x", state = "active")),
        agents = listOf(AgentRow(id = "pa1", slug = "forge", name = "Forge", state = "idle", agentRuntime = "claude-code")),
        hosts = listOf(HostRow(id = "h1", name = "M1")),
    )

    private fun List<WorkRow>.row(key: String): WorkRow = first { it.key == key }

    private fun List<WorkRow>.keysIn(view: WorkView): List<String> = filter { WorkFeed.inView(it, view) }.map { it.key }

    @Test
    fun projectsEverySourceOntoTheSameRowShapeAndRanksNeedsYouFirst() {
        val rows = WorkFeed.collect(sources())

        assertFalse(rows.any { it.key == "terminal-lt2" }, "a local Task run is already its tasks row")
        assertEquals(listOf(WorkStatus.NEEDS_YOU, WorkStatus.NEEDS_YOU), rows.take(2).map { it.status })
        assertEquals("terminal-lt1", rows.first().key, "most recent needs-you first")

        assertEquals(WorkWhere(WorkWhere.Target.MACHINE, "M1 · ~/app"), rows.row("task-t2").where)
        assertEquals("PR 7", rows.row("task-t1").note)
        assertEquals("/tasks/t1", rows.row("task-t1").href)
        assertEquals(WorkStatus.PAUSED, rows.row("job-j1").status)
        assertEquals(WorkThen.WAITS_FOR_MESSAGES, rows.row("agent-pa1").then)
        assertEquals("terminal", rows.row("session-s1").who)
        assertEquals("armed", rows.row("blueprint-b1").statusLabel)
        assertEquals(WorkThen.WAITS_FOR_ME, rows.row("automation-a1").then)

        assertEquals(WorkCounts(needsYou = 2, running = 0, waiting = 1, recurring = 2, agents = 1), WorkFeed.count(rows))

        assertEquals(listOf("session-s1", "task-t2", "terminal-lt1", "agent-pa1").sorted(), rows.keysIn(WorkView.ACTIVE).sorted())
        assertEquals(listOf("automation-a1", "blueprint-b1", "job-j1").sorted(), rows.keysIn(WorkView.RECURRING).sorted())
        assertEquals(listOf("task-t1"), rows.keysIn(WorkView.HISTORY))
        assertEquals(listOf("agent-pa1"), rows.keysIn(WorkView.AGENTS))
        assertEquals(rows.size, rows.keysIn(WorkView.ALL).size)
    }

    @Test
    fun theWholeOrderIsStatusRankThenRecency() {
        val rows = WorkFeed.collect(sources())
        // needs you (newest first) → waiting (agent, session: no timestamps, input order) →
        // scheduled (blueprint, automation) → paused (job) → done (task).
        assertEquals(
            listOf("terminal-lt1", "task-t2", "session-s1", "agent-pa1", "blueprint-b1", "automation-a1", "job-j1", "task-t1"),
            rows.map { it.key },
        )
    }

    @Test
    fun rowsLeadToTheirKindsDetailScreen() {
        val rows = WorkFeed.collect(sources())
        assertEquals(WorkDestination.Task("t1"), rows.row("task-t1").destination)
        assertEquals(WorkDestination.Blueprint("b1"), rows.row("blueprint-b1").destination)
        assertEquals(WorkDestination.Job("j1"), rows.row("job-j1").destination)
        assertEquals(WorkDestination.LocalTerminal("lt1"), rows.row("terminal-lt1").destination)
        assertEquals(WorkDestination.LocalBlueprint("a1"), rows.row("automation-a1").destination)
        assertEquals(WorkDestination.PodSession("s1"), rows.row("session-s1").destination)
        assertEquals(WorkDestination.Agent("pa1"), rows.row("agent-pa1").destination)
    }

    @Test
    fun destinationsMapToTheOwningFeaturesRoutes() {
        assertEquals(TaskDetailRoute("t"), WorkDestination.Task("t").route())
        assertEquals(ScheduledDetailRoute("b"), WorkDestination.Blueprint("b").route())
        assertEquals(JobDetailRoute("j"), WorkDestination.Job("j").route())
        assertEquals(JobRunRoute(jobId = "j", runId = "r"), WorkDestination.JobRun("j", "r").route())
        assertEquals(LocalTerminalRoute("lt"), WorkDestination.LocalTerminal("lt").route())
        assertEquals(LocalAutomationRoute("a"), WorkDestination.LocalBlueprint("a").route())
        assertEquals(SessionDetailRoute("s"), WorkDestination.PodSession("s").route())
        assertEquals(AgentDetailRoute("pa"), WorkDestination.Agent("pa").route())
    }

    @Test
    fun statusMaps() {
        assertEquals(WorkStatus.WAITING, WorkFeed.taskStatus("pr_opened").first)
        assertEquals("PR open", WorkFeed.taskStatus("pr_opened").second)
        assertEquals("waiting on deps", WorkFeed.taskStatus("waiting_on_deps").second)
        assertEquals(WorkStatus.QUEUED, WorkFeed.taskStatus("pending").first)
        assertEquals(WorkStatus.RUNNING to "provisioning", WorkFeed.taskStatus("provisioning"))
        assertEquals(WorkStatus.NEEDS_YOU to "needs attention", WorkFeed.taskStatus("needs_attention"))
        assertEquals(WorkStatus.DONE, WorkFeed.taskStatus("cancelled").first)
        assertEquals(WorkStatus.FAILED, WorkFeed.taskStatus("failed").first)
        assertEquals(WorkStatus.DONE to "", WorkFeed.taskStatus(null))

        assertEquals("host offline", WorkFeed.terminalStatus(TerminalRow(state = "pending", pendingReason = "host_offline")).second)
        assertEquals(WorkStatus.QUEUED to "pending", WorkFeed.terminalStatus(TerminalRow(state = "pending", pendingReason = "hold")))
        assertEquals(WorkStatus.WAITING, WorkFeed.terminalStatus(TerminalRow(state = "running", attentionState = "idle")).first)
        assertEquals(WorkStatus.DONE, WorkFeed.terminalStatus(TerminalRow(state = "exited")).first)
        assertEquals(WorkStatus.FAILED to "error", WorkFeed.terminalStatus(TerminalRow(state = "error", attentionState = "needs_you")))
        assertEquals(WorkStatus.RUNNING to "working", WorkFeed.terminalStatus(TerminalRow(state = "launching")))

        assertEquals(WorkStatus.DONE, WorkFeed.agentStatus(AgentRow(state = "archived")).first)
        assertEquals("idle", WorkFeed.agentStatus(AgentRow(state = null)).second)
        assertEquals(WorkStatus.RUNNING to "provisioning", WorkFeed.agentStatus(AgentRow(state = "provisioning")))
        assertEquals(WorkStatus.WAITING to "hibernating", WorkFeed.agentStatus(AgentRow(state = "hibernating")))
    }

    @Test
    fun headlessAgentTerminalsExitAndSpawnedRunsAreMarked() {
        val rows = WorkFeed.collect(
            Sources(
                localTerminals = listOf(
                    TerminalRow(
                        id = "h", title = "headless", state = "running", attentionState = "working",
                        spec = spec("agent", agent = "codex", mode = "headless"), spawnedBy = "job", workflowRunId = "r1",
                    ),
                ),
            ),
        )
        val row = rows.single()
        assertEquals(WorkThen.EXITS, row.then)
        assertEquals("codex", row.who)
        assertEquals("job", row.whenLabel)
        assertTrue(row.spawned)
        assertEquals(WorkStatus.RUNNING, row.status)
    }

    @Test
    fun searchMatchesNamePlaceAgentStatusAndNote() {
        val rows = WorkFeed.collect(sources())
        assertEquals(listOf("session-s1", "task-t1"), rows.filter { WorkFeed.matches(it, "acme") }.map { it.key }.sorted())
        assertEquals(listOf("job-j1"), rows.filter { WorkFeed.matches(it, "GEMINI") }.map { it.key })
        assertEquals(listOf("task-t1"), rows.filter { WorkFeed.matches(it, "PR 7") }.map { it.key })
        assertEquals(rows.size, rows.count { WorkFeed.matches(it, "  ") })
        assertEquals(listOf("blueprint-b1", "automation-a1"), rows.filter { WorkFeed.matches(it, "armed") }.map { it.key })
    }

    @Test
    fun shortLabels() {
        assertEquals("acme/app", WorkFeed.shortRepo("https://github.com/acme/app.git"))
        assertEquals("group/proj", WorkFeed.shortRepo("https://gitlab.example.com/group/proj"))
        assertEquals("x", WorkFeed.shortRepo("x"))
        assertNull(WorkFeed.shortRepo(null))
        assertNull(WorkFeed.shortRepo(""))
        assertEquals("~/app", WorkFeed.shortDir("/Users/dev/app"))
        assertEquals("~/notes", WorkFeed.shortDir("/home/dev/notes"))
        assertEquals("~", WorkFeed.shortDir("/Users/dev"))
        assertEquals("/srv/x", WorkFeed.shortDir("/srv/x"))
        assertNull(WorkFeed.shortDir(null))
        assertEquals("Claude Code", WorkFeed.runtimeLabel("claude-code"))
        assertEquals("OpenAI Codex", WorkFeed.runtimeLabel("codex"))
        assertEquals("mystery", WorkFeed.runtimeLabel("mystery"))
        assertEquals("terminal", WorkFeed.runtimeLabel("terminal"))
    }

    @Serializable
    private data class UnifiedEnvelope(val tasks: List<UnifiedRow>)

    @Test
    fun decodesLooseRows() {
        val json = """{"tasks":[{"type":"repo-task","id":"t1","title":"x","state":"running","metadata":{"taskConfigId":"c1","extra":1},"priority":5}]}"""
        val rows = WorkFeed.collect(Sources(unified = OptioJson.decodeFromString<UnifiedEnvelope>(json).tasks))
        assertEquals("on a trigger", rows.first().whenLabel)
        assertTrue(rows.first().spawned)
    }

    @Test
    fun oddNestedShapesCostOneFieldNotTheList() {
        // `metadata` as a non-object and `spec` missing its kind still decode; the rows fall back.
        val json = """{"tasks":[{"type":"repo-task","id":"t1","title":"x","state":"running","metadata":"legacy"},
            |{"type":"repo-task","id":"t2","state":"queued","metadata":{"taskConfigId":7}},{"type":"mystery","id":"m"}]}""".trimMargin()
        val rows = WorkFeed.collect(Sources(unified = OptioJson.decodeFromString<UnifiedEnvelope>(json).tasks))
        assertEquals(listOf("task-t1", "task-t2"), rows.map { it.key }, "unknown types are skipped")
        assertEquals(listOf("now", "now"), rows.map { it.whenLabel })
        assertEquals("", rows.first { it.key == "task-t2" }.name, "a missing title projects as empty (the row shows Untitled)")
    }

    @Test
    fun rowLabelsAndChipsFollowTheWeb() {
        val rows = WorkFeed.collect(
            Sources(
                unified = listOf(
                    UnifiedRow(type = "repo-task", id = "t", title = "PR slash", state = "pr_opened", prUrl = "https://github.com/a/b/pull/12/"),
                    UnifiedRow(type = "repo-task", id = "e", title = "Empty PR", state = "running", prUrl = ""),
                    UnifiedRow(type = "standalone", id = "j", name = "Local job", runTarget = "local", localHostId = "h9", localDir = "/srv/jobs"),
                ),
                localTerminals = listOf(
                    TerminalRow(id = "n", title = null, state = "running", attentionState = "needs_you", attentionReason = "", spawnedBy = null),
                    TerminalRow(id = "b", title = "From automation", state = "exited", blueprintId = "a1", spawnedBy = "blueprint", hostId = "gone"),
                ),
                podSessions = listOf(
                    PodSessionRow(id = "0123456789", title = "Investigate cold start", branch = "session/x", state = "active"),
                    PodSessionRow(id = "abcdefghij", title = "", branch = null, state = "ended", endedAt = "2026-09-01T00:00:00Z"),
                ),
                agents = listOf(AgentRow(id = "pa", slug = "forge", name = null, state = "running")),
            ),
        )
        rows.row("task-t").let {
            assertEquals("PR 12", it.note, "a trailing slash still finds the number")
            assertEquals(WorkStatus.WAITING, it.status)
            assertEquals("now", it.whenLabel)
            assertEquals(WhenKind.NOW, it.whenKind)
        }
        rows.row("task-e").let {
            assertNull(it.note)
            assertNull(it.prUrl, "an empty PR link is no link")
        }
        rows.row("job-j").let {
            assertEquals(WorkWhere(WorkWhere.Target.MACHINE, "/srv/jobs"), it.where, "an unknown host drops out")
            assertEquals(WhenKind.TRIGGER, it.whenKind)
            assertEquals("Claude Code", it.whoLabel)
        }
        rows.row("terminal-n").let {
            assertEquals("Terminal", it.name)
            assertEquals("now", it.whenLabel)
            assertNull(it.note, "an empty attention reason is no note")
            assertEquals(WorkWhere(WorkWhere.Target.MACHINE, null), it.where)
            assertEquals("machine", it.where.label)
            assertEquals("terminal", it.whoLabel)
            assertTrue(it.isTerminal)
        }
        rows.row("terminal-b").let {
            assertEquals("blueprint", it.whenLabel)
            assertTrue(it.spawned)
            assertFalse(it.recurring)
        }
        assertEquals("Investigate cold start", rows.row("session-0123456789").name, "sessions are named by title first (web)")
        assertEquals("Session abcdefgh", rows.row("session-abcdefghij").name)
        assertEquals("2026-09-01T00:00:00Z", rows.row("session-abcdefghij").lastActivity)
        rows.row("agent-pa").let {
            assertEquals("forge", it.name)
            assertEquals("@forge", it.where.detail)
            assertEquals(WhenKind.MESSAGES, it.whenKind)
            assertEquals("Optio pod", WorkWhere(WorkWhere.Target.POD, null).label)
        }
    }

    @Test
    fun countsSkipPausedRecurringAndFinishedAgents() {
        val rows = WorkFeed.collect(
            Sources(
                unified = listOf(
                    UnifiedRow(type = "repo-blueprint", id = "on", enabled = true),
                    UnifiedRow(type = "repo-blueprint", id = "off", enabled = false),
                    UnifiedRow(type = "repo-task", id = "q", state = "queued"),
                    UnifiedRow(type = "repo-task", id = "r", state = "running"),
                    UnifiedRow(type = "repo-task", id = "pr", state = "pr_opened"),
                ),
                agents = listOf(
                    AgentRow(id = "idle", state = "idle"),
                    AgentRow(id = "gone", state = "archived"),
                    AgentRow(id = "paused", state = "paused"),
                ),
            ),
        )
        // Waiting counts the PR task but not the idle agent; agents count everything not done.
        assertEquals(WorkCounts(needsYou = 0, running = 2, waiting = 1, recurring = 1, agents = 2), WorkFeed.count(rows))
    }
}
