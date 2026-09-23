package dev.optio.core.testing

import dev.optio.core.model.AgentLimitWindow
import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.LocalAgentKind
import dev.optio.core.model.LocalAgentSessionMode
import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalBlueprint
import dev.optio.core.model.LocalBlueprintSpawnMode
import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalHostAgentLimits
import dev.optio.core.model.LocalHostDir
import dev.optio.core.model.LocalHostState
import dev.optio.core.model.LocalSpawnSource
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.LocalTerminalSpec
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.model.OptioTask
import dev.optio.core.model.PersistentAgent
import dev.optio.core.model.PersistentAgentPodLifecycle
import dev.optio.core.model.PersistentAgentState
import dev.optio.core.model.RunTarget
import dev.optio.core.model.TaskState
import dev.optio.core.model.WorkLink
import dev.optio.core.model.WorkLinkKind
import dev.optio.core.model.WorkLinkProvider
import dev.optio.core.model.Workflow
import dev.optio.core.model.WorkflowRun
import dev.optio.core.model.WorkflowRunState
import dev.optio.core.network.CurrentUser
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/**
 * Realistic sample models for tests and screenshots, relative to one fixed [NOW] so relative times
 * render the same on every run. Every builder takes named overrides:
 * `Samples.task(state = TaskState.FAILED, errorMessage = "Tests failed")`.
 */
object Samples {
    /** 2026-09-22 16:40:00 UTC: the "now" of every sample and of [captureScreens]. */
    val NOW: Instant = Instant.parse("2026-09-22T16:40:00Z")

    /** A clock frozen at [NOW] in UTC (provide it as `LocalClock`). */
    val clock: Clock = Clock.fixed(NOW, ZoneOffset.UTC)

    /** [NOW] minus [minutes]. */
    fun ago(minutes: Long): Instant = NOW.minus(Duration.ofMinutes(minutes))

    /** [ago] as the ISO string many rows carry (`2026-09-22T16:38:00.000Z`). */
    fun agoIso(minutes: Long): String = ago(minutes).toString()

    // region Tasks, jobs, runs

    fun task(
        id: String = "5f1c2a9e-8d7b-4c3e-9a1f-2b6d8e4c7a10",
        title: String = "Fix flaky login test",
        prompt: String = "The login e2e test fails intermittently; find the race and fix it.",
        state: TaskState = TaskState.RUNNING,
        repoUrl: String = "https://github.com/acme/web",
        repoBranch: String = "main",
        agentType: String = "claude-code",
        prUrl: String? = null,
        errorMessage: String? = null,
        resultSummary: String? = null,
        metadata: Map<String, JsonElement>? = null,
        retryCount: Int = 0,
        runTarget: RunTarget? = RunTarget.CLUSTER,
        createdAt: Instant = ago(42),
        startedAt: Instant? = ago(40),
        completedAt: Instant? = null,
        lastActivityAt: Instant? = ago(1),
    ) = OptioTask(
        id = id,
        title = title,
        prompt = prompt,
        repoUrl = repoUrl,
        repoBranch = repoBranch,
        state = state,
        agentType = agentType,
        prUrl = prUrl,
        errorMessage = errorMessage,
        resultSummary = resultSummary,
        metadata = metadata,
        retryCount = retryCount.toDouble(),
        maxRetries = 3.0,
        lastActivityAt = lastActivityAt,
        runTarget = runTarget,
        createdAt = createdAt,
        updatedAt = lastActivityAt ?: createdAt,
        startedAt = startedAt,
        completedAt = completedAt,
    )

    fun workflow(
        id: String = "wf-nightly",
        name: String = "Nightly release notes",
        description: String? = "Summarise yesterday's merged PRs into release notes.",
        promptTemplate: String = "Write release notes for {{repo}} since {{since}}.",
        agentRuntime: String = "claude-code",
        model: String? = "sonnet",
        enabled: Boolean = true,
        runTarget: RunTarget = RunTarget.CLUSTER,
        createdAt: Instant = ago(60 * 24 * 12),
    ) = Workflow(
        id = id,
        name = name,
        description = description,
        promptTemplate = promptTemplate,
        agentRuntime = agentRuntime,
        model = model,
        maxConcurrent = 2.0,
        maxRetries = 2.0,
        warmPoolSize = 0.0,
        runTarget = runTarget,
        enabled = enabled,
        createdAt = createdAt,
        updatedAt = createdAt,
    )

    fun workflowRun(
        id: String = "run-1",
        workflowId: String = "wf-nightly",
        title: String? = "Release notes for acme/web",
        state: WorkflowRunState = WorkflowRunState.COMPLETED,
        costUsd: String? = "0.0520",
        modelUsed: String? = "claude-sonnet-4-5",
        errorMessage: String? = null,
        params: Map<String, JsonElement>? = mapOf("repo" to JsonPrimitive("acme/web")),
        startedAt: Instant? = ago(95),
        finishedAt: Instant? = ago(93),
        createdAt: Instant = ago(96),
    ) = WorkflowRun(
        id = id,
        workflowId = workflowId,
        params = params,
        title = title,
        state = state,
        costUsd = costUsd,
        inputTokens = 18_234.0,
        outputTokens = 1_912.0,
        modelUsed = modelUsed,
        errorMessage = errorMessage,
        retryCount = 0.0,
        startedAt = startedAt,
        finishedAt = finishedAt,
        createdAt = createdAt,
        updatedAt = finishedAt ?: createdAt,
    )

    // endregion

    // region Persistent agents

    fun persistentAgent(
        id: String = "agent-captain",
        slug: String = "release-captain",
        name: String = "Release Captain",
        description: String? = "Cuts releases and keeps the changelog honest.",
        state: PersistentAgentState = PersistentAgentState.IDLE,
        podLifecycle: PersistentAgentPodLifecycle = PersistentAgentPodLifecycle.STICKY,
        enabled: Boolean = true,
        totalCostUsd: String = "1.8420",
        lastTurnAt: Instant? = ago(18),
        createdAt: Instant = ago(60 * 24 * 30),
    ) = PersistentAgent(
        id = id,
        slug = slug,
        name = name,
        description = description,
        agentRuntime = "claude-code",
        model = "sonnet",
        initialPrompt = "You are the release captain for acme/web.",
        podLifecycle = podLifecycle,
        idlePodTimeoutMs = 600_000.0,
        maxTurnDurationMs = 1_800_000.0,
        maxTurns = 50.0,
        consecutiveFailureLimit = 3.0,
        state = state,
        enabled = enabled,
        totalCostUsd = totalCostUsd,
        consecutiveFailures = 0.0,
        lastTurnAt = lastTurnAt,
        reconcileAttempts = 0.0,
        createdAt = createdAt,
        updatedAt = lastTurnAt ?: createdAt,
    )

    // endregion

    // region Optio Local

    fun codexLimits(
        primaryUsed: Double = 42.5,
        secondaryUsed: Double? = 7.0,
        planType: String? = "pro",
        observedAt: String = agoIso(20),
    ) = LocalHostAgentLimits.Codex(
        primary = AgentLimitWindow(usedPercent = primaryUsed, windowMinutes = 300.0, resetsAt = NOW.plus(Duration.ofMinutes(140)).toString()),
        secondary = secondaryUsed?.let { AgentLimitWindow(usedPercent = it, windowMinutes = 10_080.0, resetsAt = NOW.plus(Duration.ofDays(4)).toString()) },
        planType = planType,
        observedAt = observedAt,
    )

    fun localHost(
        id: String = "9d2e4c6a-8b0f-4a1e-b3c5-d7e9f1a3b5c7",
        name: String = "mbp",
        hostname: String = "jons-mbp.tail1234.ts.net",
        state: LocalHostState = LocalHostState.ONLINE,
        dirs: List<LocalHostDir> = listOf(
            LocalHostDir("/Users/dev/acme/web", repoUrl = "https://github.com/acme/web"),
            LocalHostDir("/Users/dev/scratch"),
        ),
        codex: LocalHostAgentLimits.Codex? = null,
        lastSeenAt: String? = agoIso(0),
    ) = LocalHost(
        id = id,
        name = name,
        hostname = hostname,
        platform = "darwin",
        arch = "arm64",
        daemonVersion = "0.6.3",
        dirs = dirs,
        agentLimits = codex?.let { LocalHostAgentLimits(codex = it) },
        claudeCredentials = true,
        state = state,
        lastSeenAt = lastSeenAt,
        createdAt = agoIso(60 * 24 * 40),
        updatedAt = agoIso(1),
    )

    fun localTerminal(
        id: String = "term-web",
        hostId: String = "9d2e4c6a-8b0f-4a1e-b3c5-d7e9f1a3b5c7",
        title: String = "Fix the flaky login test",
        dir: String = "/Users/dev/acme/web",
        state: LocalTerminalState = LocalTerminalState.RUNNING,
        attentionState: LocalAttentionState = LocalAttentionState.NEEDS_YOU,
        attentionReason: String? = "permission",
        spec: LocalTerminalSpec = LocalTerminalSpec.Agent(
            agent = LocalAgentKind.CLAUDE_CODE,
            prompt = "Fix the flaky login test",
            mode = LocalAgentSessionMode.INTERACTIVE,
        ),
        spawnedBy: LocalSpawnSource = LocalSpawnSource.MANUAL,
        preview: String? = "Allow Bash(npm test)? (y/n)",
        links: List<WorkLink> = listOf(WorkLink("https://github.com/acme/web/pull/42", WorkLinkKind.PR, WorkLinkProvider.GITHUB, "acme/web#42")),
        costUsd: String? = "0.0184",
        exitCode: Int? = null,
        createdAt: String = agoIso(25),
        lastActivityAt: String? = agoIso(2),
    ) = LocalTerminal(
        id = id,
        hostId = hostId,
        title = title,
        dir = dir,
        command = "claude",
        spec = spec,
        state = state,
        exitCode = exitCode?.toDouble(),
        attentionState = attentionState,
        attentionReason = attentionReason,
        spawnedBy = spawnedBy,
        preview = preview,
        links = links,
        costUsd = costUsd,
        lastActivityAt = lastActivityAt,
        createdAt = createdAt,
        updatedAt = lastActivityAt ?: createdAt,
        startedAt = createdAt,
    )

    fun localBlueprint(
        id: String = "bp-flaky",
        name: String = "Fix flaky tests",
        agent: LocalAgentKind? = LocalAgentKind.CLAUDE_CODE,
        enabled: Boolean = true,
    ) = LocalBlueprint(
        id = id,
        name = name,
        description = "Every morning, find and fix one flaky test.",
        dir = "/Users/dev/acme/web",
        commandTemplate = "Find the flakiest test in {{suite}} and fix it.",
        agent = agent,
        spawnMode = LocalBlueprintSpawnMode.AUTO,
        sessionMode = LocalAgentSessionMode.HEADLESS,
        enabled = enabled,
        createdAt = agoIso(60 * 24 * 7),
        updatedAt = agoIso(60 * 24),
    )

    // endregion

    // region Agent logs

    /** One log entry. */
    fun logEntry(
        type: AgentLogEntry.TypeValue,
        content: String,
        metadata: Map<String, JsonElement>? = null,
        minutesAgo: Long = 5,
        taskId: String = "5f1c2a9e-8d7b-4c3e-9a1f-2b6d8e4c7a10",
    ) = AgentLogEntry(taskId = taskId, timestamp = agoIso(minutesAgo), type = type, content = content, metadata = metadata)

    /**
     * A realistic transcript: the prompt you typed, thinking, markdown prose, a tool call with its
     * paired result, a failing command, a standalone tool result, an error and a system line.
     */
    fun transcript(): List<AgentLogEntry> {
        fun meta(vararg pairs: Pair<String, Any>): Map<String, JsonElement> = pairs.associate { (k, v) ->
            k to when (v) {
                is Boolean -> JsonPrimitive(v)
                is Number -> JsonPrimitive(v)
                else -> JsonPrimitive(v.toString())
            }
        }
        return listOf(
            logEntry(AgentLogEntry.TypeValue.SYSTEM, "session 7f3c · claude-sonnet-4-5 · /workspace/web", minutesAgo = 12),
            logEntry(
                AgentLogEntry.TypeValue.TEXT,
                "The login e2e test fails about one run in five. Find the race and fix it.",
                meta("role" to "user"),
                minutesAgo = 12,
            ),
            logEntry(
                AgentLogEntry.TypeValue.THINKING,
                "The failure is intermittent, so it's probably timing: the test may click before the session cookie lands.",
                minutesAgo = 11,
            ),
            logEntry(
                AgentLogEntry.TypeValue.TOOL_USE,
                "{\"command\":\"npx playwright test e2e/login.spec.ts --repeat-each=10\"}",
                meta("toolName" to "Bash", "summary" to "npx playwright test e2e/login.spec.ts --repeat-each=10", "result" to "8 passed, 2 failed (login.spec.ts:24 timed out)", "resultIsError" to false),
                minutesAgo = 11,
            ),
            logEntry(
                AgentLogEntry.TypeValue.TOOL_USE,
                "{\"file_path\":\"e2e/login.spec.ts\"}",
                meta("toolName" to "Read", "summary" to "e2e/login.spec.ts"),
                minutesAgo = 10,
            ),
            logEntry(
                AgentLogEntry.TypeValue.TEXT,
                "Found it. `login.spec.ts` navigates to **/dashboard** right after submitting, but the session " +
                    "cookie is set by a redirect that can land later:\n\n" +
                    "1. submit the form\n2. wait for `/api/auth/session`\n3. then navigate\n\n" +
                    "```ts\nawait page.waitForResponse('**/api/auth/session')\n```",
                minutesAgo = 9,
            ),
            logEntry(
                AgentLogEntry.TypeValue.TOOL_USE,
                "{\"command\":\"npm run lint\"}",
                meta("toolName" to "Bash", "summary" to "npm run lint", "result" to "error  'page' is not defined  no-undef", "resultIsError" to true, "exitCode" to 1),
                minutesAgo = 8,
            ),
            logEntry(AgentLogEntry.TypeValue.TOOL_RESULT, "", meta("toolName" to "Edit"), minutesAgo = 7),
            logEntry(AgentLogEntry.TypeValue.ERROR, "API Error: 529 overloaded — retrying in 4s", minutesAgo = 6),
            logEntry(
                AgentLogEntry.TypeValue.TEXT,
                "Fixed and verified: 20/20 runs pass. Opened [acme/web#42](https://github.com/acme/web/pull/42).",
                minutesAgo = 5,
            ),
        )
    }

    // endregion

    /** A signed-in member (`/api/auth/me`). */
    fun currentUser(
        role: String? = CurrentUser.ROLE_MEMBER,
        authDisabled: Boolean = false,
    ) = CurrentUser(
        id = "user-1",
        provider = "github",
        email = "dev@example.com",
        displayName = "Dev Example",
        username = "devexample",
        workspaceId = "ws-1",
        role = role,
        authDisabled = authDisabled,
    )
}
