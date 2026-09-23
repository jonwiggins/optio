package dev.optio.feature.workform

import kotlin.random.Random
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

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
//   THEN   what happens when a turn ends: exits / waits for me / persistent agent
//   NAME   yours, or "Job N" / "Terminal N" for its kind
//
// `normalize` keeps a draft inside the space: an upstream change (say, a trigger) moves the
// downstream answers it invalidates (a bare terminal becomes an agent), never the other way round.

// region Vocabulary

/** What happens when a turn ends. */
enum class Then(val raw: String) {
    EXITS("exits"),
    WAITS_FOR_ME("waits-for-me"),
    WAITS_FOR_MESSAGES("waits-for-messages"),
    ;

    companion object {
        fun fromRaw(raw: String?): Then? = entries.firstOrNull { it.raw == raw }
    }
}

/** The trigger types a `TriggerConfig` carries (`trigger-selector.tsx`). */
enum class TriggerType(val raw: String) {
    MANUAL("manual"),
    SCHEDULE("schedule"),
    WEBHOOK("webhook"),
    TICKET("ticket"),
    ;

    companion object {
        fun fromRaw(raw: String?): TriggerType? = entries.firstOrNull { it.raw == raw }
    }
}

/** Event triggers: a GitHub / Slack / Linear event starts the work. */
enum class EventTriggerType(val raw: String) {
    GITHUB("github"),
    SLACK("slack"),
    LINEAR("linear"),
    ;

    companion object {
        fun fromRaw(raw: String?): EventTriggerType? = entries.firstOrNull { it.raw == raw }
    }
}

/** The When answer: a plain trigger type or an event. */
enum class WhenType(val raw: String, val label: String) {
    MANUAL("manual", "Now"),
    SCHEDULE("schedule", "Schedule"),
    WEBHOOK("webhook", "Webhook"),
    TICKET("ticket", "Ticket"),
    GITHUB("github", "GitHub"),
    SLACK("slack", "Slack"),
    LINEAR("linear", "Linear"),
    ;

    /** The event this When is, or null for a plain trigger. */
    val event: EventTriggerType?
        get() = EventTriggerType.fromRaw(raw)

    val isEvent: Boolean
        get() = event != null

    /** The plain trigger type this When is, or null for an event. */
    val trigger: TriggerType?
        get() = TriggerType.fromRaw(raw)

    /** The answer as a menu shows it (iOS `menuLabel`): "On a schedule". */
    val menuLabel: String
        get() = when (this) {
            MANUAL -> "Now"
            SCHEDULE -> "On a schedule"
            WEBHOOK -> "By webhook"
            TICKET -> "From a ticket"
            GITHUB -> "GitHub event"
            SLACK -> "Slack message"
            LINEAR -> "Linear event"
        }

    companion object {
        fun fromRaw(raw: String?): WhenType? = entries.firstOrNull { it.raw == raw }
    }
}

/** Where ticket triggers read from. */
enum class TicketSource(val raw: String, val label: String) {
    GITHUB("github", "GitHub"),
    LINEAR("linear", "Linear"),
    JIRA("jira", "Jira"),
    NOTION("notion", "Notion"),
    ;

    companion object {
        fun fromRaw(raw: String?): TicketSource? = entries.firstOrNull { it.raw == raw }
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

/** `TriggerConfig` in trigger-selector.tsx. */
data class TriggerConfig(
    val type: TriggerType = TriggerType.MANUAL,
    val cronExpression: String? = null,
    val webhookPath: String? = null,
    val ticketSource: TicketSource? = null,
    val ticketLabels: List<String>? = null,
) {
    companion object {
        val MANUAL = TriggerConfig()
    }
}

/**
 * An event trigger's config, in the shape the trigger routes store: GitHub
 * `{ events, login, repos? }`, Slack `{ channelId, mentionOnly, keyword?, includeThreads? }`,
 * Linear `{ events, user, teams?, labels? }`.
 */
data class EventTrigger(
    val type: EventTriggerType,
    val config: JsonObject,
) {
    companion object {
        fun default(type: EventTriggerType): EventTrigger = EventTrigger(type, defaultEventConfig(type))
    }
}

/** A fresh event config for [type] (`DEFAULT_EVENT_CONFIG` in work-form.tsx). */
fun defaultEventConfig(type: EventTriggerType): JsonObject = when (type) {
    EventTriggerType.GITHUB -> jsonObjectOf("events" to jsonArrayOf("review_requested", "mentioned"), "login" to JsonPrimitive(""))
    EventTriggerType.SLACK -> jsonObjectOf("channelId" to JsonPrimitive(""), "mentionOnly" to JsonPrimitive(false))
    EventTriggerType.LINEAR -> jsonObjectOf("events" to jsonArrayOf("assigned", "mentioned"), "user" to JsonPrimitive(""))
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

/** A model / provider option value (string or boolean), keyed like the repo columns. */
sealed interface OptionValue {
    data class Str(val value: String) : OptionValue

    data class Bool(val value: Boolean) : OptionValue

    val stringValue: String?
        get() = (this as? Str)?.value

    val boolValue: Boolean?
        get() = (this as? Bool)?.value

    /** A blank select means "the runtime's default". */
    val isBlank: Boolean
        get() = this is Str && value.isEmpty()

    val json: JsonPrimitive
        get() = when (this) {
            is Str -> JsonPrimitive(value)
            is Bool -> JsonPrimitive(value)
        }

    companion object {
        /** A JSON string or boolean as an option value; null for anything else. */
        fun fromJson(element: JsonElement?): OptionValue? {
            val primitive = element as? JsonPrimitive ?: return null
            if (primitive.isString) return Str(primitive.content)
            return primitive.booleanOrNull?.let(::Bool)
        }
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
    val agent: AgentExtras = AgentExtras(),
    /** Blank = "<Kind> N" (see [WorkKind.word]). */
    val name: String = "",
    /** Triggered work only: what each run is named, with the trigger's params. Blank = the name. */
    val runName: String = "",
    val description: String = "",
    val priority: Int = 100,
    val maxRetries: Int = 3,
    val dependsOn: List<String> = emptyList(),
) {
    companion object {
        val EMPTY = WorkDraft()
    }
}

// endregion

// region Runtimes

data class Runtime(val value: String, val label: String)

val RUNTIMES: List<Runtime> = listOf(
    Runtime("claude-code", "Claude Code"),
    Runtime("codex", "OpenAI Codex"),
    Runtime("copilot", "GitHub Copilot"),
    Runtime("gemini", "Google Gemini"),
    Runtime("cursor", "Cursor"),
    Runtime("opencode", "OpenCode"),
    Runtime("openclaw", "OpenClaw"),
)

/** The runtime value of "a terminal with no agent". */
const val TERMINAL = ""

/** "Claude Code" for a runtime, "terminal" for [TERMINAL]. */
fun runtimeLabel(runtime: String): String {
    if (runtime == TERMINAL) return "terminal"
    return RUNTIMES.firstOrNull { it.value == runtime }?.label ?: runtime
}

/** `LOCAL_AGENT_KINDS` in packages/shared: the CLIs the daemon can launch. */
val LOCAL_AGENT_KINDS: Set<String> = setOf("claude-code", "codex", "cursor", "gemini", "opencode")

fun runsLocally(runtime: String): Boolean = runtime in LOCAL_AGENT_KINDS

/** `providerForAgentType` in packages/shared/src/agent-options. */
fun providerFor(runtime: String): String = when (runtime) {
    "codex" -> "openai"
    "gemini" -> "gemini"
    "copilot" -> "copilot"
    "opencode" -> "opencode"
    "openclaw" -> "openclaw"
    "cursor" -> "cursor"
    else -> "anthropic"
}

/**
 * `ProviderCatalog.modelField` per provider: the repo column the model lives in. Known statically
 * so the form can carry a model even when the catalog fetch fails.
 */
fun modelFieldForProvider(provider: String): String = when (provider) {
    "openai", "copilot" -> "copilotModel"
    "gemini" -> "geminiModel"
    "opencode" -> "opencodeModel"
    "openclaw" -> "openclawModel"
    "cursor" -> "cursorModel"
    else -> "claudeModel"
}

fun modelFieldForRuntime(runtime: String): String = modelFieldForProvider(providerFor(runtime))

/** A stored alias ("opus") shows as the model it resolves to (`agent-options-picker.tsx`). */
fun resolveModel(raw: String, aliases: Map<String, String>?): String = aliases?.get(raw) ?: raw

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

// region Trigger params

/**
 * The `{{param}}`s a prompt can use, per trigger: what the trigger worker, the webhook receiver
 * and the event services put in `params`.
 */
val TRIGGER_PARAMS: Map<WhenType, List<String>> = mapOf(
    WhenType.MANUAL to emptyList(),
    WhenType.SCHEDULE to emptyList(),
    WhenType.WEBHOOK to emptyList(),
    WhenType.TICKET to listOf("ticketSource", "ticketExternalId", "ticketTitle", "ticketBody", "ticketUrl", "ticketLabels"),
    WhenType.GITHUB to listOf(
        "event", "kind", "repo", "repoUrl", "number", "title", "body", "url", "author", "headBranch", "baseBranch",
        "commentBody", "commentUrl", "action",
    ),
    WhenType.SLACK to listOf("channelId", "userId", "text", "ts", "threadTs", "permalink"),
    WhenType.LINEAR to listOf(
        "event", "identifier", "title", "description", "url", "labels", "teamKey", "assignee", "priority", "state",
        "commentBody", "commentUrl", "actor", "ticketTitle", "ticketBody", "ticketUrl", "ticketLabels",
    ),
)

fun triggerParams(whenType: WhenType): List<String> = TRIGGER_PARAMS[whenType].orEmpty()

// endregion

// region Cron / webhook helpers (trigger-selector.tsx)

data class CronPreset(val label: String, val expr: String)

val CRON_PRESETS: List<CronPreset> = listOf(
    CronPreset("Every hour", "0 * * * *"),
    CronPreset("Every 6h", "0 */6 * * *"),
    CronPreset("Daily 09:00 UTC", "0 9 * * *"),
    CronPreset("Weekdays 09:00 UTC", "0 9 * * 1-5"),
    CronPreset("Mon 09:00 UTC", "0 9 * * 1"),
)

/** Plain English for the cron presets, for the sentence. */
val CRON_WORDS: Map<String, String> = mapOf(
    "0 * * * *" to "every hour",
    "0 */6 * * *" to "every 6 hours",
    "0 9 * * *" to "daily at 09:00 UTC",
    "0 9 * * 1-5" to "weekdays at 09:00 UTC",
    "0 9 * * 1" to "Mondays at 09:00 UTC",
)

private val WHITESPACE = Regex("\\s+")

/** Five whitespace-separated fields. */
fun cronIsValid(expr: String?): Boolean {
    val trimmed = expr?.trim().orEmpty()
    if (trimmed.isEmpty()) return false
    return trimmed.split(WHITESPACE).size == 5
}

/** `hook-` plus 8 random lowercase letters and digits. */
fun randomWebhookPath(random: Random = Random.Default): String {
    val alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    return "hook-" + (1..8).map { alphabet[random.nextInt(alphabet.length)] }.joinToString("")
}

// endregion

// region Event kinds (local/automations-section.tsx)

data class EventKind(val value: String, val label: String, val personal: Boolean)

val GITHUB_KINDS: List<EventKind> = listOf(
    EventKind("review_requested", "Review requested from me", personal = true),
    EventKind("mentioned", "I'm @-mentioned", personal = true),
    EventKind("assigned", "Assigned to me", personal = true),
    EventKind("pr_opened", "Any PR opened", personal = false),
    EventKind("issue_opened", "Any issue opened", personal = false),
)

val LINEAR_KINDS: List<EventKind> = listOf(
    EventKind("assigned", "Assigned to me", personal = true),
    EventKind("mentioned", "I'm @-mentioned", personal = true),
    EventKind("created", "Any issue created", personal = false),
    EventKind("labeled", "A label is added", personal = false),
)

fun eventKinds(type: EventTriggerType): List<EventKind> = when (type) {
    EventTriggerType.GITHUB -> GITHUB_KINDS
    EventTriggerType.LINEAR -> LINEAR_KINDS
    EventTriggerType.SLACK -> emptyList()
}

/** GitHub / Linear event kinds that are "about you" and need a login to match. */
val PERSONAL_EVENT_KINDS: Map<EventTriggerType, List<String>> = mapOf(
    EventTriggerType.GITHUB to listOf("review_requested", "mentioned", "assigned"),
    EventTriggerType.SLACK to emptyList(),
    EventTriggerType.LINEAR to listOf("assigned", "mentioned"),
)

/** Slack channel ids look like C0123ABCD (the API rejects anything else). */
val SLACK_CHANNEL_ID = Regex("^[A-Z][A-Z0-9]{5,}$")

/** The config key that names "you" for an event trigger: `login` (GitHub) or `user` (Linear). */
fun identityKey(type: EventTriggerType): String = if (type == EventTriggerType.GITHUB) "login" else "user"

/** The event kinds an event config has checked. */
fun eventsOf(config: JsonObject): List<String> =
    (config["events"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.orEmpty()

/**
 * What an event trigger still needs before the API would accept it: the same rules the trigger
 * routes enforce, checked up front so a rejected trigger never strands a half-created row.
 */
fun eventGaps(e: EventTrigger): List<SentenceField> {
    val c = e.config
    if (e.type == EventTriggerType.SLACK) {
        return if (SLACK_CHANNEL_ID.matches(c.string("channelId"))) emptyList() else listOf(SentenceField.CHANNEL)
    }
    val events = eventsOf(c)
    // No kinds checked would mean "every kind" to the matcher: make it a choice.
    if (events.isEmpty()) return listOf(SentenceField.EVENTS)
    val personal = events.any { it in PERSONAL_EVENT_KINDS[e.type].orEmpty() }
    val identity = c.string(identityKey(e.type)).trim()
    if (personal && identity.isEmpty()) return listOf(SentenceField.IDENTITY)
    return emptyList()
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
    return next
}

/**
 * Which agent parameters the run will honor. Every pod run (a Task over the repo's defaults, a
 * Job, a persistent agent) reads the runtime's full provider option set. On your machine the
 * daemon passes the CLI just a model; its other settings come from the machine's own config.
 */
fun fullOptionsApply(d: WorkDraft): Boolean = !isLocal(d) && d.runtime != TERMINAL

/**
 * The repo's configured values for this runtime's options, to seed the picker. [keys] = the
 * catalog's model field plus its option keys (the web reads them off the static catalog).
 */
fun optionsFromRepo(runtime: String, repo: JsonObject?, keys: List<String>): Map<String, OptionValue> {
    if (repo == null || runtime == TERMINAL) return emptyMap()
    val out = LinkedHashMap<String, OptionValue>()
    for (k in keys) OptionValue.fromJson(repo[k])?.let { out[k] = it }
    return out
}

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

// region JSON helpers

internal fun jsonObjectOf(vararg pairs: Pair<String, JsonElement>): JsonObject = JsonObject(linkedMapOf(*pairs))

internal fun jsonArrayOf(vararg values: String): JsonArray = JsonArray(values.map(::JsonPrimitive))

/** [this] with [key] set to [value] (keeps key order; a new key goes last). */
internal fun JsonObject.with(key: String, value: JsonElement): JsonObject = JsonObject(LinkedHashMap(this).apply { put(key, value) })

/** The string at [key], or "" (`String(c[key] ?? "")` for strings). */
internal fun JsonObject.string(key: String): String = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()

internal fun JsonObject.bool(key: String): Boolean = (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull ?: false

/** A string list at [key] (comma lists in the event filters). */
internal fun JsonObject.strings(key: String): List<String> =
    (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.orEmpty()

// endregion
