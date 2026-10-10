package dev.optio.feature.workform

import dev.optio.core.model.boolValue
import dev.optio.core.model.intValue
import dev.optio.core.model.stringValue
import dev.optio.core.ui.triggers.EventTrigger
import dev.optio.core.ui.triggers.EventTriggerType
import dev.optio.core.ui.triggers.TicketSource
import dev.optio.core.ui.triggers.TriggerConfig
import dev.optio.core.ui.triggers.TriggerGap
import dev.optio.core.ui.triggers.TriggerType
import dev.optio.core.ui.triggers.WhenType
import dev.optio.core.ui.triggers.eventGaps
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import dev.optio.core.ui.agent.RUNTIMES
import dev.optio.core.network.AGENT_CREDENTIAL_OPTION_KEY
import dev.optio.core.ui.agent.TERMINAL
import dev.optio.core.ui.agent.OptionValue

// Port of `apps/web/src/components/work-form/model.ts` (the reference implementation; iOS
// `Features/Work/Feed/New/WorkFormModel.swift` ports the same file). Pure data and pure functions:
// the form state, the submitter and the screen sit on top. Names follow the web / iOS so the three
// can be read side by side (`when` is `whenType` here: `when` is a Kotlin keyword).
//
// One piece of work, five attributes. Every kind of work Optio runs (a Task that opens a PR, a Job,
// a scheduled blueprint, a Local automation, an interactive terminal, a Persistent Agent) is a
// point in this space, and the storage row it becomes (`deriveKind`) is a pure function of the
// point.
//
//   WHEN   what starts it: now, a schedule, a webhook, a ticket, or a GitHub / Slack / Linear
//          event (every When works with every Where)
//   WHERE  an Optio pod (with one of your repos, or none) or your own machine (in the directory
//          as it is, or on a new branch that becomes a PR)
//   WHO    a terminal with no agent, or an agent runtime and its parameters
//   WHAT   the prompt (agents only), with the trigger's params available
//   THEN   what happens when a turn ends: exits / works until the PR merges / waits for me /
//          persistent agent
//   NAME   yours, or "Job N" / "Terminal N" for its kind
//
// `normalize` keeps a draft inside the space: an upstream change (say, a trigger) moves the
// downstream answers it invalidates (a bare terminal becomes an agent), never the other way round.

// region Vocabulary

/** What happens when a turn ends. */
enum class Then(val raw: String) {
    EXITS("exits"),

    /** Opens a PR, then comes back for failing CI, conflicts and review feedback until it merges. */
    UNTIL_MERGED("until-merged"),
    WAITS_FOR_ME("waits-for-me"),
    WAITS_FOR_MESSAGES("waits-for-messages"),
    ;

    /** One headless run (or one per firing), not a session (web `isOneShot`). */
    val isOneShot: Boolean
        get() = this == EXITS || this == UNTIL_MERGED

    companion object {
        fun fromRaw(raw: String?): Then? = entries.firstOrNull { it.raw == raw }
    }
}

/** Where the work runs: an Optio pod or the user's own machine. */
enum class Where(val raw: String) {
    CLUSTER("cluster"),
    LOCAL("local"),
    ;

    companion object {
        fun fromRaw(raw: String?): Where? = entries.firstOrNull { it.raw == raw }
    }
}

/** A local run exits when its turn is done, or stays at its prompt. */
enum class LocalSessionMode(val raw: String) {
    HEADLESS("headless"),
    INTERACTIVE("interactive"),
}

/** A persistent agent's pod lifecycle. */
enum class PodLifecycle(val raw: String, val label: String, val hint: String) {
    STICKY("sticky", "Sticky", "The pod stays warm for a while after each turn, then goes away until the next wake."),
    ALWAYS_ON("always-on", "Always on", "The pod never goes away — fastest wake, highest cost."),
    ON_DEMAND("on-demand", "On demand", "A fresh pod for every turn — slowest wake, nothing idle."),
}

/** `RunLocationValue` in run-location-picker.tsx. */
data class RunLocation(
    val runTarget: Where = Where.CLUSTER,
    val localHostId: String = "",
    val localDir: String = "",
    val localSessionMode: LocalSessionMode = LocalSessionMode.HEADLESS,
) {
    companion object {
        val CLUSTER = RunLocation()
    }
}

/** The persistent-agent-only answers. */
data class AgentExtras(
    val slug: String = "",
    val podLifecycle: PodLifecycle = PodLifecycle.STICKY,
    val systemPrompt: String = "",
    val agentsMd: String = "",
)

// endregion

// region The draft

/** One point in the attribute space (`WorkDraft`). */
data class WorkDraft(
    val whenType: WhenType = WhenType.MANUAL,
    val trigger: TriggerConfig = TriggerConfig.MANUAL,
    val event: EventTrigger = EventTrigger.default(EventTriggerType.GITHUB),
    val location: RunLocation = RunLocation.CLUSTER,
    /**
     * Pod: one of your registered repos (vs. no repo). Machine: work on a new branch that becomes
     * a PR (vs. the directory as it is). Either way it means "this work produces a PR".
     */
    val withRepo: Boolean = true,
    val repoId: String = "",
    val repoUrl: String = "",
    val repoBranch: String = "main",
    /** `""` ([TERMINAL]) = a terminal with no agent. */
    val runtime: String = "claude-code",
    /** Model + provider options for the runtime (keys from the provider catalog). */
    val agentOptions: Map<String, OptionValue> = emptyMap(),
    val prompt: String = "",
    val then: Then = Then.EXITS,
    /**
     * [Then.UNTIL_MERGED] only: merge the PR once it's green and approved (vs. keep it green and
     * leave the merge to you).
     */
    val mergeWhenReady: Boolean = true,
    val agent: AgentExtras = AgentExtras(),
    /** Blank = "<Kind> N" (see [WorkKind.word]). */
    val name: String = "",
    /** Triggered work only: what each run is named, with the trigger's params. Blank = the name. */
    val runName: String = "",
    val description: String = "",
    val priority: Int = 100,
    val maxRetries: Int = 3,
    val dependsOn: List<String> = emptyList(),
    /** Pod work: who it belongs to (Organization / Private). Work on a machine is always the owner's. */
    val owner: WorkOwner = WorkOwner.WORKSPACE,
    /**
     * Pod work: the secrets (by name) the agent gets in its pod. Null = a saved row's legacy
     * behavior (left as is on save); new work always sends a list, possibly empty.
     */
    val podSecrets: List<String>? = emptyList(),
) {
    companion object {
        val EMPTY = WorkDraft()
    }
}

// endregion

// region Runtimes

// The runtimes themselves (RUNTIMES, TERMINAL, providerFor, …) live in :core:ui
// (`dev.optio.core.ui.agent`), shared with the repo settings.

/** `LOCAL_AGENT_KINDS` in packages/shared: the CLIs the daemon can launch. */
val LOCAL_AGENT_KINDS: Set<String> = setOf("claude-code", "codex", "cursor", "gemini", "opencode")

fun runsLocally(runtime: String): Boolean = runtime in LOCAL_AGENT_KINDS

// endregion

// region Presets

/** An example that fills the form in. [id] is also `NewWorkRoute(preset)`'s argument. */
class Preset(
    val id: String,
    val label: String,
    val hint: String,
    val apply: (WorkDraft) -> WorkDraft,
)

val PRESETS: List<Preset> = listOf(
    Preset("pr", "Open a PR", "An agent changes a repo on a branch and opens a pull request.") { d ->
        d.copy(
            whenType = WhenType.MANUAL,
            trigger = TriggerConfig.MANUAL,
            location = d.location.copy(runTarget = Where.CLUSTER),
            withRepo = true,
            runtime = d.runtime.ifEmpty { "claude-code" },
            agentOptions = emptyMap(),
            then = Then.EXITS,
        )
    },
    Preset("assign", "Assign to Optio", "Issues labeled optio become PRs an agent works on until they merge.") { d ->
        d.copy(
            whenType = WhenType.TICKET,
            trigger = TriggerConfig(type = TriggerType.TICKET, ticketSource = TicketSource.GITHUB, ticketLabels = listOf("optio")),
            location = d.location.copy(runTarget = Where.CLUSTER),
            withRepo = true,
            runtime = d.runtime.ifEmpty { "claude-code" },
            agentOptions = emptyMap(),
            then = Then.UNTIL_MERGED,
            mergeWhenReady = true,
        )
    },
    Preset("chat", "Interactive chat", "An agent session on your machine you can type into.") { d ->
        d.copy(
            whenType = WhenType.MANUAL,
            trigger = TriggerConfig.MANUAL,
            location = d.location.copy(runTarget = Where.LOCAL, localSessionMode = LocalSessionMode.INTERACTIVE),
            withRepo = false,
            runtime = d.runtime.ifEmpty { "claude-code" },
            agentOptions = emptyMap(),
            then = Then.WAITS_FOR_ME,
        )
    },
    Preset("terminal", "Terminal", "A plain shell on your machine — no agent, no prompt.") { d ->
        d.copy(
            whenType = WhenType.MANUAL,
            trigger = TriggerConfig.MANUAL,
            location = d.location.copy(runTarget = Where.LOCAL, localSessionMode = LocalSessionMode.INTERACTIVE),
            withRepo = false,
            runtime = TERMINAL,
            agentOptions = emptyMap(),
            prompt = "",
            then = Then.WAITS_FOR_ME,
        )
    },
    Preset("schedule", "Scheduled run", "An agent runs on a cron with no repo and exits.") { d ->
        d.copy(
            whenType = WhenType.SCHEDULE,
            trigger = TriggerConfig(type = TriggerType.SCHEDULE, cronExpression = "0 9 * * *"),
            location = d.location.copy(runTarget = Where.CLUSTER),
            withRepo = false,
            runtime = d.runtime.ifEmpty { "claude-code" },
            agentOptions = emptyMap(),
            then = Then.EXITS,
        )
    },
    Preset("agent", "Persistent agent", "A named agent that keeps memory and wakes on messages.") { d ->
        d.copy(
            whenType = WhenType.MANUAL,
            trigger = TriggerConfig.MANUAL,
            location = d.location.copy(runTarget = Where.CLUSTER),
            withRepo = false,
            runtime = d.runtime.ifEmpty { "claude-code" },
            agentOptions = emptyMap(),
            then = Then.WAITS_FOR_MESSAGES,
        )
    },
)

fun preset(id: String?): Preset? = PRESETS.firstOrNull { it.id == id }

// endregion

// region Trigger gaps as sentence fields

/** The trigger's gaps as the sentence's fields (`CHANNEL` / `EVENTS` / `IDENTITY`). */
fun eventSentenceGaps(e: EventTrigger): List<SentenceField> = eventGaps(e).map { gap ->
    when (gap) {
        TriggerGap.CHANNEL -> SentenceField.CHANNEL
        TriggerGap.EVENTS -> SentenceField.EVENTS
        TriggerGap.IDENTITY -> SentenceField.IDENTITY
        TriggerGap.CRON -> SentenceField.CRON
        TriggerGap.WEBHOOK -> SentenceField.WEBHOOK
    }
}

// endregion

// region Derived facts

fun isLocal(d: WorkDraft): Boolean = d.location.runTarget == Where.LOCAL

fun isTriggered(d: WorkDraft): Boolean = d.whenType != WhenType.MANUAL

/** One answer of an exclusive set; [disabled] says why it can't be picked right now. */
data class Choice<T>(val value: T, val disabled: String? = null) {
    val isEnabled: Boolean
        get() = disabled == null
}

/** Pod or machine. Every trigger (a schedule, a webhook, a ticket, an event) works with either. */
@Suppress("UNUSED_PARAMETER")
fun whereOptions(d: WorkDraft): List<Choice<Where>> = listOf(Choice(Where.CLUSTER), Choice(Where.LOCAL))

/** The terminal and the runtimes the picked Where allows. */
fun runtimeOptions(d: WorkDraft): List<Choice<String>> {
    val local = isLocal(d)
    val terminal = Choice(
        TERMINAL,
        when {
            isTriggered(d) -> "A trigger starts an agent — a terminal is opened by hand, pick Now above."
            !local && !d.withRepo -> "A pod terminal is attached to a repo — pick a repository above."
            else -> null
        },
    )
    val agents = RUNTIMES.map { r -> Choice(r.value, if (local && !runsLocally(r.value)) "runs in pods only" else null) }
    return listOf(terminal) + agents
}

/** Exit conditions, given everything above them. */
fun thenOptions(d: WorkDraft): List<Choice<Then>> {
    val local = isLocal(d)
    val terminal = d.runtime == TERMINAL
    return listOf(
        Choice(Then.EXITS, if (terminal) "A terminal with no agent waits for you." else null),
        Choice(
            Then.UNTIL_MERGED,
            when {
                terminal -> "Following a PR through needs an agent to fix what CI and reviewers find."
                !d.withRepo ->
                    if (local) "It works on the PR it opens — pick “On a new branch” above." else "It works on the PR it opens — pick a repository above."
                else -> null
            },
        ),
        Choice(
            Then.WAITS_FOR_ME,
            when {
                !local && !d.withRepo -> "A pod terminal is attached to a repo — pick a repository above."
                !local && isTriggered(d) -> "A pod terminal is opened by hand. On your machine, triggers can open one."
                !local && !terminal && d.runtime != "claude-code" ->
                    "A pod session chats with Claude Code — pick Terminal or Claude Code above."
                else -> null
            },
        ),
        Choice(
            Then.WAITS_FOR_MESSAGES,
            when {
                local -> "Persistent agents run in an Optio pod so they stay reachable."
                terminal -> "A persistent agent needs an agent runtime."
                d.withRepo -> "Persistent agents don't attach to a repo — pick No repo above."
                else -> null
            },
        ),
    )
}

private fun <T> firstEnabled(choices: List<Choice<T>>, current: T): T =
    choices.firstOrNull { it.value == current && it.isEnabled }?.value
        ?: choices.firstOrNull { it.isEnabled }?.value
        ?: current

/**
 * Snaps a draft back into the space its upstream answers allow, after any change. Upstream wins:
 * When over Where over Who over Then.
 */
fun normalize(d: WorkDraft): WorkDraft {
    var next = d
    val where = firstEnabled(whereOptions(next), next.location.runTarget)
    if (where != next.location.runTarget) next = next.copy(location = next.location.copy(runTarget = where))
    // A runtime that can't run here falls back to the first agent that can, never silently to a
    // bare terminal, which is a different kind of work.
    val runtimes = runtimeOptions(next)
    val runtime = if (runtimes.any { it.value == next.runtime && it.isEnabled }) {
        next.runtime
    } else {
        firstEnabled(runtimes.filter { it.value != TERMINAL }, next.runtime)
    }
    if (runtime != next.runtime) next = next.copy(runtime = runtime, agentOptions = emptyMap())
    val then = firstEnabled(thenOptions(next), next.then)
    if (then != next.then) next = next.copy(then = then)
    val mode = if (next.then == Then.WAITS_FOR_ME) LocalSessionMode.INTERACTIVE else LocalSessionMode.HEADLESS
    if (next.location.localSessionMode != mode) next = next.copy(location = next.location.copy(localSessionMode = mode))
    // A credential (a server-side secret) never ships to a machine: its own CLI login runs there.
    if (isLocal(next) && AGENT_CREDENTIAL_OPTION_KEY in next.agentOptions) {
        next = next.copy(agentOptions = next.agentOptions - AGENT_CREDENTIAL_OPTION_KEY)
    }
    return next
}

/**
 * Which agent parameters the run will honor. Every pod run (a Task over the repo's defaults, a
 * Job, a persistent agent) reads the runtime's full provider option set. On your machine the
 * daemon passes the CLI just a model; its other settings come from the machine's own config.
 */
fun fullOptionsApply(d: WorkDraft): Boolean = !isLocal(d) && d.runtime != TERMINAL

private val NON_SLUG = Regex("[^a-z0-9]+")

/** A slug for a persistent agent, from its name. */
fun slugify(name: String): String = name.lowercase().replace(NON_SLUG, "-").trim('-').take(40)

private val SSH_SHORTHAND = Regex("^[\\w-]+@([^:]+):(.+)$")
private val SSH_PROTO = Regex("^ssh://[^@]+@([^:/]+)(?::\\d+)?/(.+)$")
private val HTTP_SCHEME = Regex("^https?://", RegexOption.IGNORE_CASE)
private val TRAILING_SLASHES = Regex("/+$")
private val GIT_SUFFIX = Regex("\\.git$")

/**
 * `normalizeRepoUrl` in packages/shared: a checkout's remote as the API wants it (the daemon
 * reports remotes verbatim, often `git@host:owner/repo.git`; `POST /api/tasks` wants https).
 * Null for a missing or blank remote.
 */
fun repoUrlFromRemote(remote: String?): String? {
    var u = remote?.trim().orEmpty()
    if (u.isEmpty()) return null
    SSH_SHORTHAND.find(u)?.let { u = "https://${it.groupValues[1]}/${it.groupValues[2]}" }
    SSH_PROTO.find(u)?.let { u = "https://${it.groupValues[1]}/${it.groupValues[2]}" }
    u = u.replace(HTTP_SCHEME, "https://")
    if (!u.startsWith("https://")) u = "https://$u"
    u = u.replace(TRAILING_SLASHES, "")
    u = u.replace(GIT_SUFFIX, "")
    u = u.replace(TRAILING_SLASHES, "")
    u = u.lowercase()
    u = u.replace(TRAILING_SLASHES, "")
    return u
}

/** `github.com/owner/repo` for display. */
fun shortRepo(repoUrl: String): String = (repoUrlFromRemote(repoUrl) ?: repoUrl).removePrefix("https://")

private val HOME_PREFIX = Regex("^/Users/[^/]+|^/home/[^/]+")

/** `/Users/jon/repos/app` → `~/repos/app`. */
fun shortDir(dir: String): String = dir.replaceFirst(HOME_PREFIX, "~")

// endregion

// region PR follow-through

/** The repo settings that decide what happens to a PR after it opens (web `RepoPrSettings`). */
data class RepoPrSettings(
    val autoResume: Boolean? = null,
    val autoMerge: Boolean? = null,
    val cautiousMode: Boolean? = null,
    val reviewEnabled: Boolean? = null,
    val reviewTrigger: String? = null,
    val maxAutoResumes: Int? = null,
) {
    companion object {
        /** Reads the columns off a raw `/api/repos` row. */
        fun from(row: JsonObject?): RepoPrSettings? {
            row ?: return null
            return RepoPrSettings(
                autoResume = row["autoResume"]?.boolValue,
                autoMerge = row["autoMerge"]?.boolValue,
                cautiousMode = row["cautiousMode"]?.boolValue,
                reviewEnabled = row["reviewEnabled"]?.boolValue,
                reviewTrigger = row["reviewTrigger"]?.stringValue,
                maxAutoResumes = row["maxAutoResumes"]?.intValue,
            )
        }
    }
}

/** The server's cap when a repo sets none (`OPTIO_MAX_AUTO_RESUMES`' default). */
const val DEFAULT_MAX_AUTO_RESUMES = 10

/** One line of "What happens to the PR". */
data class FollowThroughStep(val key: String, val label: String, val on: Boolean, val detail: String? = null)

/** The checklist, and whether it comes from the repo's settings (vs. this work's own). */
data class FollowThrough(val fromRepo: Boolean, val steps: List<FollowThroughStep>)

/**
 * What happens to the PR once the agent opens it, step by step — the same rules the reconciler
 * applies: a task's own follow-through ([Then.UNTIL_MERGED]) wins over the repo's settings, review
 * is always the repo's, and cautious mode (draft PRs) never merges. Null when the work doesn't open
 * a PR.
 */
fun followThrough(d: WorkDraft, repo: RepoPrSettings?): FollowThrough? {
    if (!d.withRepo || d.runtime == TERMINAL || !d.then.isOneShot) return null
    val own = d.then == Then.UNTIL_MERGED
    val resume = if (own) true else repo?.autoResume == true
    val merge = if (own) d.mergeWhenReady else repo?.autoMerge == true
    val cautious = repo?.cautiousMode == true
    val cap = repo?.maxAutoResumes ?: DEFAULT_MAX_AUTO_RESUMES
    // The reconciler launches a review only on these two triggers.
    val reviewOn = repo?.reviewEnabled == true && (repo.reviewTrigger == "on_pr" || repo.reviewTrigger == "on_ci_pass")
    val resumes = "the agent picks it back up (up to $cap times)"
    return FollowThrough(
        fromRepo = !own,
        steps = listOf(
            FollowThroughStep(
                "pr",
                if (cautious) "Opens a draft PR" else "Opens a PR",
                on = true,
                detail = "The agent's turn ends here; Optio watches CI and reviews from then on.",
            ),
            FollowThroughStep(
                "review",
                "A review agent reviews it",
                on = reviewOn,
                detail = when {
                    !reviewOn -> "Off for this repo — turn it on in the repo's settings."
                    repo?.reviewTrigger == "on_pr" -> "As soon as the PR opens."
                    else -> "Once CI passes."
                },
            ),
            FollowThroughStep(
                "ci",
                "Fixes failing CI and merge conflicts",
                on = resume,
                detail = if (resume) "When checks fail or it conflicts, $resumes." else "It waits for you.",
            ),
            FollowThroughStep(
                "changes",
                "Addresses requested changes",
                on = resume,
                detail = if (resume) "When a reviewer requests changes, $resumes." else "It waits for you to resume it.",
            ),
            FollowThroughStep(
                "merge",
                "Merges when it's ready",
                on = merge && !cautious,
                detail = when {
                    merge && cautious -> "Held back: this repo opens draft PRs (cautious mode), so a person merges."
                    merge -> "Squash-merges once checks pass and any blocking review is done."
                    else -> "You merge it."
                },
            ),
            FollowThroughStep("done", "Completes on merge, fails if the PR is closed", on = true),
        ),
    )
}

// endregion

// region Kind: the storage row a draft becomes

enum class WorkKind(
    val raw: String,
    /** The bare word for default names ("Job 12"). */
    val word: String,
    /** What a saved row is called, for "saved as a …" hints. */
    val noun: String,
) {
    /** `tasks` (one-shot, opens a PR). */
    REPO_TASK("repo-task", "Task", "a Task"),

    /** `task_configs` + trigger. */
    REPO_BLUEPRINT("repo-blueprint", "Task", "a scheduled Task"),

    /** `workflows` (+ trigger, or run now). */
    STANDALONE("standalone", "Job", "a Job"),

    /** `local_blueprints` + trigger (interactive + trigger on a machine). */
    LOCAL_BLUEPRINT("local-blueprint", "Automation", "a Local automation"),

    /** `local_terminals` (interactive, on a machine). */
    LOCAL_TERMINAL("local-terminal", "Terminal", "a terminal"),

    /** `interactive_sessions` (interactive, in a repo pod). */
    POD_SESSION("pod-session", "Session", "a pod session"),

    /** `persistent_agents`. */
    PERSISTENT_AGENT("persistent-agent", "Agent", "a persistent agent"),
    ;

    companion object {
        fun fromRaw(raw: String?): WorkKind? = entries.firstOrNull { it.raw == raw }
    }
}

fun deriveKind(d: WorkDraft): WorkKind {
    if (d.then == Then.WAITS_FOR_MESSAGES) return WorkKind.PERSISTENT_AGENT
    if (d.then == Then.WAITS_FOR_ME) {
        if (!isLocal(d)) return WorkKind.POD_SESSION
        return if (isTriggered(d)) WorkKind.LOCAL_BLUEPRINT else WorkKind.LOCAL_TERMINAL
    }
    if (d.withRepo) return if (isTriggered(d)) WorkKind.REPO_BLUEPRINT else WorkKind.REPO_TASK
    return WorkKind.STANDALONE
}

/**
 * Editing keeps the row: an answer that would make [deriveKind] land on a different table (a Job
 * becoming a Task, a pod run moving to your machine as an automation) is refused with a reason,
 * since silently deleting and recreating the row would lose its runs, webhook path and history.
 * Null when the change stays inside the saved kind (or nothing is [locked]).
 *
 * A row can sit on a point the form would file elsewhere (a headless scheduled automation on a
 * machine with no branch derives to a Job), so the kind the draft derives to right now is allowed
 * as well; the save always patches the saved row regardless.
 */
fun kindLock(d: WorkDraft, locked: WorkKind?, patch: (WorkDraft) -> WorkDraft): String? {
    if (locked == null) return null
    val next = deriveKind(normalize(patch(d)))
    if (next == locked || next == deriveKind(d)) return null
    return "This is saved as ${locked.noun} — start new work to make it something else."
}

// endregion

// endregion
