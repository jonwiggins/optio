package dev.optio.feature.workform

// The sentence of `model.ts` (`describe` / `missingFields`): "Started now, a Claude Code run in an
// Optio pod with acme/app that opens a PR and exits when done." Missing pieces render as gaps that
// point at their field, so the sentence is also the validation.

/** A field the sentence can point at when it is missing. */
enum class SentenceField(val raw: String, val label: String) {
    CHECKOUT("checkout", "checkout"),
    REPO("repo", "repo"),
    MACHINE("machine", "machine"),
    PROMPT("prompt", "prompt"),
    CRON("cron", "cron"),
    WEBHOOK("webhook", "webhook"),
    IDENTITY("identity", "your username"),
    CHANNEL("channel", "channel"),
    EVENTS("events", "events"),
    ;

    /** The form section a gap scrolls to. */
    val section: FormSection
        get() = when (this) {
            CRON, WEBHOOK, IDENTITY, CHANNEL, EVENTS -> FormSection.WHEN
            CHECKOUT, REPO, MACHINE -> FormSection.WHERE
            PROMPT -> FormSection.WHAT
        }
}

/** The form's sections, in order (scroll anchors for gaps and the dev script). */
enum class FormSection { WHEN, WHERE, WHO, WHAT, THEN, NAME }

/** One piece of the sentence: plain text, or a gap that points at [field]. */
sealed interface SentencePart {
    data class Text(val text: String) : SentencePart

    data class Missing(val text: String, override val field: SentenceField) : SentencePart

    /** The field a gap points at; null for plain text. */
    val field: SentenceField?
        get() = null
}

/** Names the sentence can use for the picked repo and machine. */
data class SentenceContext(
    val repoName: String? = null,
    val machineName: String? = null,
)

private fun text(s: String): SentencePart = SentencePart.Text(s)

private fun missing(s: String, field: SentenceField): SentencePart = SentencePart.Missing(s, field)

private fun whenPhrase(d: WorkDraft): List<SentencePart> = when (d.whenType) {
    WhenType.MANUAL -> when (d.then) {
        Then.WAITS_FOR_MESSAGES -> listOf(text("Woken by messages,"))
        Then.EXITS -> listOf(text("Started now,"))
        Then.WAITS_FOR_ME -> listOf(text("Opened now,"))
    }
    WhenType.SCHEDULE -> {
        val cron = d.trigger.cronExpression?.trim().orEmpty()
        if (!cronIsValid(cron)) {
            listOf(text("Running"), missing("on a schedule", SentenceField.CRON), text(","))
        } else {
            listOf(text("Running ${CRON_WORDS[cron] ?: "on `$cron`"},"))
        }
    }
    WhenType.WEBHOOK -> {
        val path = d.trigger.webhookPath
        if (!path.isNullOrEmpty()) {
            listOf(text("Started by a webhook at /api/hooks/$path,"))
        } else {
            listOf(text("Started by"), missing("a webhook path", SentenceField.WEBHOOK), text(","))
        }
    }
    WhenType.TICKET -> listOf(text("Started by ${(d.trigger.ticketSource ?: TicketSource.GITHUB).raw} tickets,"))
    WhenType.GITHUB, WhenType.SLACK, WhenType.LINEAR -> {
        val source = when (d.whenType) {
            WhenType.GITHUB -> "GitHub events"
            WhenType.SLACK -> "Slack messages"
            else -> "Linear events"
        }
        val gaps = eventGaps(d.event)
        if (gaps.isEmpty()) {
            listOf(text("Started by $source,"))
        } else {
            val gap = when (gaps.first()) {
                SentenceField.CHANNEL -> missing("in a channel", SentenceField.CHANNEL)
                SentenceField.EVENTS -> missing("of some kind", SentenceField.EVENTS)
                else -> missing("about you", SentenceField.IDENTITY)
            }
            listOf(text("Started by $source"), gap, text(","))
        }
    }
}

/**
 * "Started now, a Claude Code run in an Optio pod with acme/app that opens a PR and exits when
 * done." Missing pieces are [SentencePart.Missing] gaps that point at their field.
 */
fun describe(d: WorkDraft, ctx: SentenceContext = SentenceContext()): List<SentencePart> {
    val parts = whenPhrase(d).toMutableList()
    val who = if (d.runtime == TERMINAL) "a terminal" else "a ${runtimeLabel(d.runtime)}"
    // Plain English for the exit condition: a run finishes, a session waits for you, an agent stays.
    val noun = when (d.then) {
        Then.WAITS_FOR_MESSAGES -> "agent"
        Then.WAITS_FOR_ME -> "session"
        Then.EXITS -> "run"
    }
    parts += text(if (d.runtime == TERMINAL) who else "$who $noun")

    when {
        d.then == Then.WAITS_FOR_MESSAGES -> parts += text("in an Optio pod")
        isLocal(d) -> {
            parts += if (d.location.localHostId.isNotEmpty()) {
                text("on ${ctx.machineName ?: "my machine"}")
            } else {
                missing("a machine", SentenceField.MACHINE)
            }
            parts += if (d.location.localDir.isNotEmpty()) {
                val where = if (d.withRepo && d.runtime != TERMINAL) "on a new branch in" else "in"
                text("$where ${shortDir(d.location.localDir)}")
            } else {
                missing(if (d.withRepo) "a checkout" else "a directory", SentenceField.CHECKOUT)
            }
        }
        else -> {
            parts += text("in an Optio pod")
            if (d.withRepo) {
                parts += if (d.repoUrl.isNotEmpty()) text("with ${ctx.repoName ?: d.repoUrl}") else missing("a repo", SentenceField.REPO)
            }
        }
    }

    parts += when (d.then) {
        Then.EXITS -> text(if (d.withRepo) "that opens a PR and exits when done." else "that exits when done.")
        Then.WAITS_FOR_ME -> text("that waits for you between turns.")
        Then.WAITS_FOR_MESSAGES -> text("that keeps its memory between turns.")
    }
    return parts
}

/** Whether [part] attaches to what came before without a space (a "," or "." piece). */
fun SentencePart.isPunctuation(): Boolean = this is SentencePart.Text && (text.startsWith(",") || text.startsWith("."))

/** The sentence as one string, missing pieces in brackets: for tests and accessibility. */
fun sentenceText(parts: List<SentencePart>): String = parts.fold("") { acc, part ->
    val t = when (part) {
        is SentencePart.Text -> part.text
        is SentencePart.Missing -> "[${part.text}]"
    }
    when {
        t.startsWith(",") || t.startsWith(".") -> acc + t
        acc.isEmpty() -> t
        else -> "$acc $t"
    }
}

/** What the sentence can't fill in, plus the prompt when the work needs one. */
fun missingFields(d: WorkDraft, ctx: SentenceContext = SentenceContext()): List<SentenceField> {
    val gaps = describe(d, ctx).mapNotNull { it.field }.toMutableList()
    val kind = deriveKind(d)
    // A terminal you open by hand needs no prompt; everything an agent runs unattended does.
    val adHocTerminal = kind == WorkKind.POD_SESSION || kind == WorkKind.LOCAL_TERMINAL
    if (!adHocTerminal && d.runtime != TERMINAL && d.prompt.isBlank()) gaps += SentenceField.PROMPT
    return gaps
}

/** The one button's label. */
fun submitLabel(d: WorkDraft, editing: Boolean = false): String = when {
    editing -> "Save changes"
    deriveKind(d) == WorkKind.PERSISTENT_AGENT -> "Create agent"
    d.whenType != WhenType.MANUAL -> "Save"
    d.then == Then.EXITS -> if (d.withRepo) "Start work (opens a PR)" else "Start work"
    else -> "Open session"
}

/**
 * Recurring work names each run (web `namesRuns`); a one-off run just takes the name. A scheduled
 * Task's run name is its `title`, a Job's and an automation's is `runTitle`.
 */
fun namesRuns(d: WorkDraft): Boolean = when (deriveKind(d)) {
    WorkKind.REPO_BLUEPRINT, WorkKind.LOCAL_BLUEPRINT -> true
    WorkKind.STANDALONE -> isTriggered(d)
    else -> false
}
