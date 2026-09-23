package dev.optio.core.workfeed

import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import dev.optio.core.navigation.WorkView
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// The unified Work feed: every kind of work Optio runs, projected onto the attributes the New
// work form asks for (When / Where / Who / Then + a status), so one list and one overview can show
// them together.
//
// A straight port of iOS `Features/Work/Feed/WorkFeed.swift`, itself a port of the web's
// `apps/web/src/lib/work-feed.ts` (the reference implementation; where the two differ this file
// follows the web and says so). The rows come from the per-kind endpoints (unified tasks, local
// terminals + automations, pod sessions, persistent agents) and are merged client-side; a
// server-side read model can replace [WorkFeed.collect] without touching the screens. Pure — no
// networking — so `WorkFeedTest` mirrors iOS `WorkFeedTests.swift` and the web's
// `work-feed.test.ts`.

/** The per-kind table a row comes from (web `WorkSource`). */
enum class WorkSource(val raw: String) {
    REPO_TASK("repo-task"),
    REPO_BLUEPRINT("repo-blueprint"),
    STANDALONE("standalone"),
    LOCAL_BLUEPRINT("local-blueprint"),
    LOCAL_TERMINAL("local-terminal"),
    POD_SESSION("pod-session"),
    PERSISTENT_AGENT("persistent-agent"),
}

/**
 * Where a row sits in the one order: needs-you first, then live, then everything by recency. The
 * declaration order is the web's `STATUS_RANK`; [id] is the web's status id.
 */
enum class WorkStatus(val id: String) {
    NEEDS_YOU("needs_you"),
    RUNNING("running"),
    QUEUED("queued"),
    WAITING("waiting"),
    SCHEDULED("scheduled"),
    PAUSED("paused"),
    FAILED("failed"),
    DONE("done"),
    ;

    /** Alive right now: the Active view. */
    val isActive: Boolean
        get() = this in ACTIVE

    companion object {
        /** The statuses of the Active view (web `ACTIVE`). */
        val ACTIVE: Set<WorkStatus> = setOf(NEEDS_YOU, RUNNING, QUEUED, WAITING)
    }
}

/** Exit conditions (`Then` in the web's `components/work-form/model.ts`); [raw] is the wire id. */
enum class WorkThen(val raw: String, val label: String) {
    EXITS("exits", "exits"),
    WAITS_FOR_ME("waits-for-me", "waits for me"),
    WAITS_FOR_MESSAGES("waits-for-messages", "persistent"),
}

/** Where a row runs: an Optio pod or a paired machine, with an optional repo / host · dir / slug. */
data class WorkWhere(
    val target: Target,
    val detail: String?,
) {
    enum class Target { POD, MACHINE }

    /** Chip copy: the detail, or the generic place. */
    val label: String
        get() = detail ?: if (target == Target.POD) "Optio pod" else "machine"
}

/** Which glyph a When chip carries (iOS `whenSystemImage`): play, cpu or clock. */
enum class WhenKind { NOW, MESSAGES, TRIGGER }

/** One piece of work, whatever kind it is (web `WorkRow`). */
data class WorkRow(
    /** Unique across kinds: `task-<id>`, `terminal-<id>`, … */
    val key: String,
    val source: WorkSource,
    /** Id of the underlying row (`tasks.id`, `local_terminals.id`, …). */
    val sourceId: String,
    /** The web route, kept for parity with the TypeScript feed. */
    val href: String,
    val name: String,
    /** What starts it, as a short label ("now", "on a trigger", "messages", "on an event", "job"). */
    val whenLabel: String,
    val where: WorkWhere,
    /** Runtime id (`claude-code`, `codex`, …), or "terminal". */
    val who: String,
    val then: WorkThen,
    val status: WorkStatus,
    val statusLabel: String,
    /** Extra one-liner: PR number, attention reason, "opens a PR each run". */
    val note: String?,
    val prUrl: String?,
    /** ISO-8601 timestamp; sorted lexically like the web. */
    val lastActivity: String?,
    /** Definitions that spawn runs (blueprints, jobs, automations). */
    val recurring: Boolean,
    /** Runs spawned from a definition / task config. */
    val spawned: Boolean,
) {
    /** The detail screen this row opens (the web's `href`). */
    val destination: WorkDestination
        get() = when (source) {
            WorkSource.REPO_TASK -> WorkDestination.Task(sourceId)
            WorkSource.REPO_BLUEPRINT -> WorkDestination.Blueprint(sourceId)
            WorkSource.STANDALONE -> WorkDestination.Job(sourceId)
            WorkSource.LOCAL_TERMINAL -> WorkDestination.LocalTerminal(sourceId)
            WorkSource.LOCAL_BLUEPRINT -> WorkDestination.LocalBlueprint(sourceId)
            WorkSource.POD_SESSION -> WorkDestination.PodSession(sourceId)
            WorkSource.PERSISTENT_AGENT -> WorkDestination.Agent(sourceId)
        }

    /** The When chip's glyph. */
    val whenKind: WhenKind
        get() = when (whenLabel) {
            "now" -> WhenKind.NOW
            "messages" -> WhenKind.MESSAGES
            else -> WhenKind.TRIGGER
        }

    /** Chip copy for Who (`runtimeLabel`): "terminal" or the runtime's name. */
    val whoLabel: String
        get() = if (isTerminal) "terminal" else WorkFeed.runtimeLabel(who)

    /** Who is a plain terminal rather than an agent runtime. */
    val isTerminal: Boolean
        get() = who == "terminal"
}

/** The page-header counts ("2 need you · 3 running · 1 waiting · 4 recurring · 1 agent"). */
data class WorkCounts(
    val needsYou: Int = 0,
    val running: Int = 0,
    val waiting: Int = 0,
    val recurring: Int = 0,
    val agents: Int = 0,
)

/** The projection: per-kind source rows in, [WorkRow]s out. */
object WorkFeed {
    // region Source rows
    //
    // The per-kind rows as the endpoints return them. Every field is optional so a server that adds
    // or drops a column never breaks the merge (the web reads the same rows as `any`). Nested
    // objects (`metadata`, `spec`) stay JSON so an odd shape costs one field, not the whole list.

    /** `GET /api/tasks?type=all`: rows tagged `type: repo-task | repo-blueprint | standalone`. */
    @Serializable
    data class UnifiedRow(
        val type: String? = null,
        val id: String? = null,
        val title: String? = null,
        val name: String? = null,
        val state: String? = null,
        val enabled: Boolean? = null,
        val repoUrl: String? = null,
        val agentType: String? = null,
        val agentRuntime: String? = null,
        val prUrl: String? = null,
        val runTarget: String? = null,
        val localHostId: String? = null,
        val localDir: String? = null,
        val metadata: JsonElement? = null,
        val createdAt: String? = null,
        val updatedAt: String? = null,
    ) {
        /** The task config that spawned this task (`metadata.taskConfigId`); null for a one-off. */
        val taskConfigId: String?
            get() = metadata?.get("taskConfigId")?.stringValue?.takeIf { it.isNotEmpty() }
    }

    /** `GET /api/local/terminals`. */
    @Serializable
    data class TerminalRow(
        val id: String? = null,
        val title: String? = null,
        val state: String? = null,
        val pendingReason: String? = null,
        val attentionState: String? = null,
        val attentionReason: String? = null,
        val hostId: String? = null,
        val dir: String? = null,
        val spec: JsonElement? = null,
        val spawnedBy: String? = null,
        val blueprintId: String? = null,
        val workflowRunId: String? = null,
        val taskId: String? = null,
        val lastActivityAt: String? = null,
        val updatedAt: String? = null,
    ) {
        /** `spec.kind`: `shell`, `command` or `agent`. */
        val specKind: String?
            get() = spec?.get("kind")?.stringValue

        /** `spec.agent` of an agent terminal (`claude-code`, `codex`, …). */
        val specAgent: String?
            get() = spec?.get("agent")?.stringValue

        /** `spec.mode` of an agent terminal: `interactive` (default) or `headless`. */
        val specMode: String?
            get() = spec?.get("mode")?.stringValue
    }

    /** `GET /api/local/blueprints` (Local automations). */
    @Serializable
    data class BlueprintRow(
        val id: String? = null,
        val name: String? = null,
        val agent: String? = null,
        val hostId: String? = null,
        val dir: String? = null,
        val sessionMode: String? = null,
        val enabled: Boolean? = null,
        val createdAt: String? = null,
        val updatedAt: String? = null,
    )

    /** `GET /api/sessions` (interactive pod sessions). */
    @Serializable
    data class PodSessionRow(
        val id: String? = null,
        val title: String? = null,
        val repoUrl: String? = null,
        val branch: String? = null,
        val state: String? = null,
        val lastActivityAt: String? = null,
        val endedAt: String? = null,
        val createdAt: String? = null,
    )

    /** `GET /api/persistent-agents`. */
    @Serializable
    data class AgentRow(
        val id: String? = null,
        val slug: String? = null,
        val name: String? = null,
        val state: String? = null,
        val agentRuntime: String? = null,
        val lastTurnAt: String? = null,
        val updatedAt: String? = null,
        val createdAt: String? = null,
    )

    /** `GET /api/local/hosts` (only the name is needed here). */
    @Serializable
    data class HostRow(
        val id: String? = null,
        val name: String? = null,
    )

    /** Everything [collect] merges: one list per endpoint. */
    data class Sources(
        val unified: List<UnifiedRow> = emptyList(),
        val localTerminals: List<TerminalRow> = emptyList(),
        val localBlueprints: List<BlueprintRow> = emptyList(),
        val podSessions: List<PodSessionRow> = emptyList(),
        val agents: List<AgentRow> = emptyList(),
        val hosts: List<HostRow> = emptyList(),
    )

    // endregion

    // region Filters

    /** Whether [row] belongs in [view] (the saved filters of the Work list). */
    fun inView(
        row: WorkRow,
        view: WorkView,
    ): Boolean = when (view) {
        WorkView.ACTIVE -> row.status.isActive
        WorkView.RECURRING -> row.recurring
        WorkView.AGENTS -> row.source == WorkSource.PERSISTENT_AGENT
        WorkView.HISTORY -> row.status == WorkStatus.DONE || row.status == WorkStatus.FAILED
        WorkView.ALL -> true
    }

    /** Needs-you first, then live, then everything by recency (stable, like the web's sort). */
    fun sort(rows: List<WorkRow>): List<WorkRow> =
        rows.sortedWith(compareBy<WorkRow> { it.status.ordinal }.thenByDescending { it.lastActivity.orEmpty() })

    /** Free-text search over name, place, agent, status and note (the web's Work page). */
    fun matches(
        row: WorkRow,
        query: String,
    ): Boolean {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) return true
        return listOfNotNull(row.name, row.where.detail, row.who, row.statusLabel, row.note)
            .any { it.lowercase().contains(needle) }
    }

    /** The page-header counts over [rows] (web `countWork`). */
    fun count(rows: List<WorkRow>): WorkCounts {
        var needsYou = 0
        var running = 0
        var waiting = 0
        var recurring = 0
        var agents = 0
        for (r in rows) {
            if (r.status == WorkStatus.NEEDS_YOU) needsYou++
            if (r.status == WorkStatus.RUNNING || r.status == WorkStatus.QUEUED) running++
            if (r.status == WorkStatus.WAITING && r.source != WorkSource.PERSISTENT_AGENT) waiting++
            if (r.recurring && r.status != WorkStatus.PAUSED) recurring++
            if (r.source == WorkSource.PERSISTENT_AGENT && r.status != WorkStatus.DONE) agents++
        }
        return WorkCounts(needsYou, running, waiting, recurring, agents)
    }

    // endregion

    // region Labels

    private val REPO_HOST = Regex("^https?://[^/]+/")
    private val HOME_DIR = Regex("^/Users/[^/]+|^/home/[^/]+")

    /** `https://github.com/acme/app.git` → `acme/app`; null for null or empty. */
    fun shortRepo(url: String?): String? {
        if (url.isNullOrEmpty()) return null
        return REPO_HOST.replaceFirst(url, "").removeSuffix(".git")
    }

    /** `/Users/dev/app` → `~/app` (also `/home/<user>`); null for null or empty. */
    fun shortDir(dir: String?): String? {
        if (dir.isNullOrEmpty()) return null
        return HOME_DIR.replaceFirst(dir, "~")
    }

    /** `RUNTIMES` in the web's `work-form/model.ts`: id → display name. */
    val runtimes: List<Pair<String, String>> = listOf(
        "claude-code" to "Claude Code",
        "codex" to "OpenAI Codex",
        "copilot" to "GitHub Copilot",
        "gemini" to "Google Gemini",
        "cursor" to "Cursor",
        "opencode" to "OpenCode",
        "openclaw" to "OpenClaw",
    )

    /** A runtime's display name; unknown ids pass through, "terminal" stays "terminal". */
    fun runtimeLabel(runtime: String): String {
        if (runtime == "terminal") return "terminal"
        return runtimes.firstOrNull { it.first == runtime }?.second ?: runtime
    }

    // endregion

    // region Status maps

    /** A task's state → status + label (`taskStatus`). */
    fun taskStatus(state: String?): Pair<WorkStatus, String> {
        val s = state.orEmpty()
        return when (s) {
            "needs_attention" -> WorkStatus.NEEDS_YOU to "needs attention"
            "running", "provisioning" -> WorkStatus.RUNNING to s
            "pr_opened" -> WorkStatus.WAITING to "PR open"
            "queued", "pending", "waiting_on_deps" -> WorkStatus.QUEUED to s.replace('_', ' ')
            "completed" -> WorkStatus.DONE to "completed"
            "failed" -> WorkStatus.FAILED to "failed"
            "cancelled" -> WorkStatus.DONE to "cancelled"
            else -> WorkStatus.DONE to s
        }
    }

    /** A Local terminal → status + label (`terminalStatus`). */
    fun terminalStatus(t: TerminalRow): Pair<WorkStatus, String> = when {
        t.state == "error" -> WorkStatus.FAILED to "error"
        t.state == "exited" -> WorkStatus.DONE to "exited"
        t.state == "pending" -> WorkStatus.QUEUED to if (t.pendingReason == "host_offline") "host offline" else "pending"
        t.attentionState == "needs_you" -> WorkStatus.NEEDS_YOU to "needs you"
        t.attentionState == "idle" -> WorkStatus.WAITING to "idle"
        else -> WorkStatus.RUNNING to "working"
    }

    /** A persistent agent → status + label (`agentStatus`). */
    fun agentStatus(a: AgentRow): Pair<WorkStatus, String> {
        val state = a.state ?: return WorkStatus.WAITING to "idle"
        return when (state) {
            "running", "provisioning" -> WorkStatus.RUNNING to state
            "queued" -> WorkStatus.QUEUED to "queued"
            "idle" -> WorkStatus.WAITING to "idle"
            "paused" -> WorkStatus.PAUSED to "paused"
            "failed" -> WorkStatus.FAILED to "failed"
            "archived" -> WorkStatus.DONE to "archived"
            else -> WorkStatus.WAITING to state
        }
    }

    // endregion

    // region Merge

    /** Every source projected onto [WorkRow]s, sorted ([sort]). */
    fun collect(src: Sources): List<WorkRow> {
        val hostName = HashMap<String, String>()
        for (h in src.hosts) {
            val id = h.id ?: continue
            val name = h.name ?: continue
            hostName[id] = name
        }

        // Empty parts drop out like the web's `.filter(Boolean)`.
        fun machine(
            hostId: String?,
            dir: String?,
        ): WorkWhere {
            val parts = listOfNotNull(hostName[hostId.orEmpty()], shortDir(dir)).filter { it.isNotEmpty() }
            return WorkWhere(WorkWhere.Target.MACHINE, parts.takeIf { it.isNotEmpty() }?.joinToString(" · "))
        }

        fun pod(detail: String?) = WorkWhere(WorkWhere.Target.POD, detail)

        val rows = ArrayList<WorkRow>()

        for (t in src.unified) {
            val id = t.id.orEmpty()
            val local = t.runTarget == "local"
            val last = t.updatedAt ?: t.createdAt
            when (t.type) {
                "repo-task" -> {
                    val (status, statusLabel) = taskStatus(t.state)
                    val spawned = t.taskConfigId != null
                    // Swift's `split` drops empty pieces, so a trailing slash still finds the number.
                    val prNumber = t.prUrl?.split('/')?.lastOrNull { it.isNotEmpty() }
                    rows += WorkRow(
                        key = "task-$id",
                        source = WorkSource.REPO_TASK,
                        sourceId = id,
                        href = "/tasks/$id",
                        name = t.title.orEmpty(),
                        whenLabel = if (spawned) "on a trigger" else "now",
                        where = if (local) machine(t.localHostId, t.localDir) else pod(shortRepo(t.repoUrl)),
                        who = t.agentType ?: "claude-code",
                        then = WorkThen.EXITS,
                        status = status,
                        statusLabel = statusLabel,
                        note = prNumber?.let { "PR $it" },
                        prUrl = t.prUrl?.takeIf { it.isNotBlank() },
                        lastActivity = last,
                        recurring = false,
                        spawned = spawned,
                    )
                }
                "repo-blueprint" -> {
                    val paused = t.enabled == false
                    rows += WorkRow(
                        key = "blueprint-$id",
                        source = WorkSource.REPO_BLUEPRINT,
                        sourceId = id,
                        href = "/tasks/scheduled/$id",
                        name = t.name ?: t.title.orEmpty(),
                        whenLabel = "on a trigger",
                        where = if (local) machine(t.localHostId, t.localDir) else pod(shortRepo(t.repoUrl)),
                        who = t.agentType ?: "claude-code",
                        then = WorkThen.EXITS,
                        status = if (paused) WorkStatus.PAUSED else WorkStatus.SCHEDULED,
                        statusLabel = if (paused) "paused" else "armed",
                        note = "opens a PR each run",
                        prUrl = null,
                        lastActivity = last,
                        recurring = true,
                        spawned = false,
                    )
                }
                "standalone" -> {
                    val paused = t.enabled == false
                    rows += WorkRow(
                        key = "job-$id",
                        source = WorkSource.STANDALONE,
                        sourceId = id,
                        href = "/jobs/$id",
                        name = t.name.orEmpty(),
                        whenLabel = "on a trigger",
                        where = if (local) machine(t.localHostId, t.localDir) else pod(null),
                        who = t.agentRuntime ?: "claude-code",
                        then = WorkThen.EXITS,
                        status = if (paused) WorkStatus.PAUSED else WorkStatus.SCHEDULED,
                        statusLabel = if (paused) "paused" else "armed",
                        note = null,
                        prUrl = null,
                        lastActivity = last,
                        recurring = true,
                        spawned = false,
                    )
                }
                else -> Unit
            }
        }

        for (t in src.localTerminals) {
            // A local Task run already has its `tasks` row above; a local Job run (workflow_runs)
            // and hand-opened terminals only exist here.
            if (!t.taskId.isNullOrEmpty()) continue
            val id = t.id.orEmpty()
            val (status, statusLabel) = terminalStatus(t)
            val isAgent = t.specKind == "agent"
            val interactive = !isAgent || t.specMode != "headless"
            val spawnedBy = t.spawnedBy.orEmpty()
            rows += WorkRow(
                key = "terminal-$id",
                source = WorkSource.LOCAL_TERMINAL,
                sourceId = id,
                href = "/local/$id",
                name = t.title ?: "Terminal",
                whenLabel = if (spawnedBy == "manual" || spawnedBy.isEmpty()) "now" else spawnedBy,
                where = machine(t.hostId, t.dir),
                who = if (isAgent) t.specAgent ?: "terminal" else "terminal",
                then = if (interactive) WorkThen.WAITS_FOR_ME else WorkThen.EXITS,
                status = status,
                statusLabel = statusLabel,
                note = if (t.attentionState == "needs_you") t.attentionReason?.takeIf { it.isNotEmpty() } else null,
                prUrl = null,
                lastActivity = t.lastActivityAt ?: t.updatedAt,
                recurring = false,
                spawned = !t.blueprintId.isNullOrEmpty() || !t.workflowRunId.isNullOrEmpty(),
            )
        }

        for (b in src.localBlueprints) {
            val id = b.id.orEmpty()
            val paused = b.enabled == false
            rows += WorkRow(
                key = "automation-$id",
                source = WorkSource.LOCAL_BLUEPRINT,
                sourceId = id,
                // The web's page about the automation (iOS kept the older `/machines#automations`).
                href = "/local/automations/$id",
                name = b.name.orEmpty(),
                whenLabel = "on an event",
                where = machine(b.hostId, b.dir),
                who = b.agent ?: "terminal",
                then = if (b.sessionMode == "headless") WorkThen.EXITS else WorkThen.WAITS_FOR_ME,
                status = if (paused) WorkStatus.PAUSED else WorkStatus.SCHEDULED,
                statusLabel = if (paused) "paused" else "armed",
                note = null,
                prUrl = null,
                lastActivity = b.updatedAt ?: b.createdAt,
                recurring = true,
                spawned = false,
            )
        }

        for (s in src.podSessions) {
            val id = s.id.orEmpty()
            val active = s.state == "active"
            rows += WorkRow(
                key = "session-$id",
                source = WorkSource.POD_SESSION,
                sourceId = id,
                href = "/sessions/$id",
                // The web names a session by its title first; iOS only knew the branch.
                name = s.title?.takeIf { it.isNotEmpty() } ?: s.branch?.takeIf { it.isNotEmpty() } ?: "Session ${id.take(8)}",
                whenLabel = "now",
                where = pod(shortRepo(s.repoUrl)),
                who = "terminal",
                then = WorkThen.WAITS_FOR_ME,
                status = if (active) WorkStatus.WAITING else WorkStatus.DONE,
                statusLabel = if (active) "open" else "ended",
                note = null,
                prUrl = null,
                lastActivity = s.lastActivityAt ?: s.endedAt ?: s.createdAt,
                recurring = false,
                spawned = false,
            )
        }

        for (a in src.agents) {
            val id = a.id.orEmpty()
            val (status, statusLabel) = agentStatus(a)
            rows += WorkRow(
                key = "agent-$id",
                source = WorkSource.PERSISTENT_AGENT,
                sourceId = id,
                href = "/agents/$id",
                name = a.name ?: a.slug.orEmpty(),
                whenLabel = "messages",
                where = pod(a.slug?.let { "@$it" }),
                who = a.agentRuntime ?: "claude-code",
                then = WorkThen.WAITS_FOR_MESSAGES,
                status = status,
                statusLabel = statusLabel,
                note = null,
                prUrl = null,
                lastActivity = a.lastTurnAt ?: a.updatedAt ?: a.createdAt,
                recurring = false,
                spawned = false,
            )
        }

        return sort(rows)
    }

    // endregion
}
