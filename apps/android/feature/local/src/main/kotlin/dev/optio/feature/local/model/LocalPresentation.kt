package dev.optio.feature.local.model

import dev.optio.core.model.LocalAgentKind
import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalSpawnSource
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.LocalTerminalPendingReason
import dev.optio.core.model.LocalTerminalSpec
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.model.WorkLink
import dev.optio.core.model.WorkLinkKind
import dev.optio.core.model.WorkLinkProvider
import dev.optio.core.ui.format.isoInstant
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.theme.Tone
import java.time.Instant

/**
 * How a Local terminal reads on screen: labels, tones, and which actions apply. A port of iOS
 * `LocalPresentation` (which mirrors the web's `terminal-card.tsx` / `attention.ts` /
 * `work-links.tsx`), pure so it is unit-tested apart from the UI.
 */
object LocalPresentation {
    val activeStates: Set<LocalTerminalState> = setOf(LocalTerminalState.PENDING, LocalTerminalState.LAUNCHING, LocalTerminalState.RUNNING)

    /** Last two path segments of an absolute dir: enough to recognise a checkout. */
    fun dirTail(dir: String): String {
        val tail = dir.split('/').filter { it.isNotEmpty() }.takeLast(2).joinToString("/")
        return tail.ifEmpty { dir }
    }

    /**
     * The daemon's attention reason in words (`ATTENTION_LABELS` in the web's terminal-card.tsx;
     * iOS knows the first five).
     */
    fun attentionLabel(reason: String?): String =
        when (reason) {
            "stop" -> "waiting for you"
            "notification" -> "wants your attention"
            "bell" -> "rang the bell"
            "quiet" -> "gone quiet — probably waiting on you"
            "finished" -> "command finished"
            "exit" -> "finished — review the result"
            "done" -> "done — review the result"
            "stale" -> "went quiet a while ago"
            else -> "needs you"
        }

    fun stateLabel(t: LocalTerminal): String {
        if (t.state == LocalTerminalState.PENDING && t.pendingReason == LocalTerminalPendingReason.HOST_OFFLINE) return "Host offline"
        if (t.state == LocalTerminalState.PENDING && t.pendingReason == LocalTerminalPendingReason.HOLD) return "Held"
        return when (t.state) {
            LocalTerminalState.PENDING -> "Pending"
            LocalTerminalState.LAUNCHING -> "Launching"
            LocalTerminalState.RUNNING -> "Running"
            LocalTerminalState.EXITED -> "Exited"
            LocalTerminalState.ERROR -> "Error"
            LocalTerminalState.UNKNOWN -> "Unknown"
        }
    }

    /** Exited or errored: nothing more will ever stream. */
    fun isDead(t: LocalTerminal): Boolean = t.state == LocalTerminalState.EXITED || t.state == LocalTerminalState.ERROR

    /**
     * A live terminal that is waiting on the human: the daemon's `needs_you`, or a running terminal
     * that has gone `idle` (an agent at its prompt in a plain shell, which the daemon can't tell
     * from a quiet command).
     */
    fun waitsOnYou(t: LocalTerminal): Boolean {
        if (isDead(t)) return false
        if (t.attentionState == LocalAttentionState.NEEDS_YOU) return true
        return t.state == LocalTerminalState.RUNNING && t.attentionState == LocalAttentionState.IDLE
    }

    /** Trailing label for a terminal that waits on you. */
    fun waitingLabel(t: LocalTerminal): String =
        if (t.attentionState == LocalAttentionState.NEEDS_YOU) attentionLabel(t.attentionReason) else "waiting for input"

    /** Terminal state → tone. Needs-you wins over everything while the process is alive. */
    fun stateTone(t: LocalTerminal): Tone {
        if (waitsOnYou(t)) return Tone.ACCENT
        return when (t.state) {
            LocalTerminalState.PENDING -> Tone.IDLE
            LocalTerminalState.LAUNCHING, LocalTerminalState.RUNNING -> Tone.WORKING
            LocalTerminalState.EXITED -> if ((t.exitCode ?: 0.0) == 0.0) Tone.IDLE else Tone.DANGER
            LocalTerminalState.ERROR -> Tone.DANGER
            LocalTerminalState.UNKNOWN -> Tone.IDLE
        }
    }

    fun attentionTone(a: LocalAttentionState): Tone =
        when (a) {
            LocalAttentionState.NEEDS_YOU -> Tone.ACCENT
            LocalAttentionState.WORKING -> Tone.WORKING
            LocalAttentionState.IDLE, LocalAttentionState.UNKNOWN -> Tone.IDLE
        }

    /** Row dot: yellow while it waits on you, red on error, purple while working, none once finished. */
    fun rowTone(t: LocalTerminal): Tone? {
        if (waitsOnYou(t)) return Tone.ACCENT
        if (t.state == LocalTerminalState.ERROR) return Tone.DANGER
        if (t.state == LocalTerminalState.EXITED) return if ((t.exitCode ?: 0.0) == 0.0) null else Tone.DANGER
        if (t.state == LocalTerminalState.PENDING || t.state == LocalTerminalState.LAUNCHING) return Tone.IDLE
        if (t.attentionState == LocalAttentionState.WORKING) return Tone.WORKING
        return Tone.IDLE
    }

    /** The spawning ticket merged in ahead of the scanned links (`collectWorkLinks`). */
    fun workLinks(t: LocalTerminal): List<WorkLink> {
        val scanned = t.links
        val ticketUrl = t.ticketUrl ?: return scanned
        if (scanned.any { it.url == ticketUrl }) return scanned
        val provider = if (t.ticketSource == "gitlab") WorkLinkProvider.GITLAB else WorkLinkProvider.GITHUB
        val label = t.ticketExternalId?.let { "#$it" } ?: "ticket"
        return listOf(WorkLink(ticketUrl, WorkLinkKind.ISSUE, provider, label)) + scanned
    }

    /**
     * `owner/repo#519` → `PR #519`; `group/proj!45` → `MR !45`; ticket refs (`ENG-12`) as they are.
     * The repo is implied by the terminal's directory, so a badge carries only the number.
     */
    fun shortLinkLabel(link: WorkLink): String {
        val label = link.label
        val i = label.indexOfLast { it == '#' || it == '!' }
        if (i < 0) return label
        val number = label.substring(i)
        return when (link.kind) {
            WorkLinkKind.PR -> (if (number.startsWith("!")) "MR " else "PR ") + number
            else -> number
        }
    }

    /** Parked-on-offline-host terminals spawn themselves on reconnect; Start would only 409. */
    fun canStart(t: LocalTerminal): Boolean = t.state == LocalTerminalState.PENDING && t.pendingReason != LocalTerminalPendingReason.HOST_OFFLINE

    fun canKill(t: LocalTerminal): Boolean = t.state == LocalTerminalState.RUNNING || t.state == LocalTerminalState.LAUNCHING

    fun canDelete(t: LocalTerminal): Boolean = t.state == LocalTerminalState.EXITED || t.state == LocalTerminalState.ERROR || t.state == LocalTerminalState.PENDING

    /**
     * An exited agent run whose CLI reported its own session id can be picked up as a chat ("Resume
     * chat", `claude --resume` / `codex resume`; the web's `canResume`).
     */
    fun canResume(t: LocalTerminal): Boolean {
        if (t.state != LocalTerminalState.EXITED || t.agentSessionId.isNullOrEmpty()) return false
        val spec = t.spec as? LocalTerminalSpec.Agent ?: return false
        return spec.agent == LocalAgentKind.CLAUDE_CODE || spec.agent == LocalAgentKind.CODEX
    }

    /** "Later" applies to what sits in the needs-you queue: a live terminal waiting on you, or a finished one. */
    fun canSnooze(t: LocalTerminal): Boolean = waitsOnYou(t) || (t.attentionState == LocalAttentionState.NEEDS_YOU && isDead(t))

    /** The server's `snoozedUntil`, when it is still in the future. */
    fun snoozedUntil(
        t: LocalTerminal,
        now: Instant,
    ): Instant? = t.snoozedUntil?.isoInstant()?.takeIf { it.isAfter(now) }

    /** An agent CLI terminal (the Screen face then takes prose: autocorrect on). */
    fun isAgent(t: LocalTerminal): Boolean = t.spec is LocalTerminalSpec.Agent

    /** What runs in the terminal, for a meta line: the command, else the spec in words. */
    fun specLabel(t: LocalTerminal): String =
        when (val spec = t.spec) {
            LocalTerminalSpec.Shell -> "shell"
            is LocalTerminalSpec.Command -> spec.command
            is LocalTerminalSpec.Agent -> agentLabel(spec.agent)
            is LocalTerminalSpec.Unknown -> ""
        }

    fun agentLabel(a: LocalAgentKind): String =
        when (a) {
            LocalAgentKind.CLAUDE_CODE -> "Claude Code"
            LocalAgentKind.CODEX -> "Codex"
            LocalAgentKind.CURSOR -> "Cursor"
            LocalAgentKind.GEMINI -> "Gemini"
            LocalAgentKind.OPENCODE -> "OpenCode"
            LocalAgentKind.UNKNOWN -> a.raw
        }

    /** The agents a Local automation can run, in the web's order. */
    val agents: List<LocalAgentKind> =
        listOf(LocalAgentKind.CLAUDE_CODE, LocalAgentKind.CODEX, LocalAgentKind.CURSOR, LocalAgentKind.GEMINI, LocalAgentKind.OPENCODE)

    fun spawnSourceLabel(s: LocalSpawnSource): String =
        when (s) {
            LocalSpawnSource.MANUAL -> "manual"
            LocalSpawnSource.TICKET -> "ticket"
            LocalSpawnSource.TRIGGER -> "trigger"
            LocalSpawnSource.BLUEPRINT -> "automation"
            LocalSpawnSource.API -> "api"
            LocalSpawnSource.RESUME -> "resumed"
            LocalSpawnSource.JOB -> "job"
            LocalSpawnSource.TASK -> "task"
            LocalSpawnSource.UNKNOWN -> s.raw
        }

    /** When the terminal last did something (falls back to `updatedAt`). */
    fun activityAt(t: LocalTerminal): Instant? = (t.lastActivityAt ?: t.updatedAt).isoInstant()

    /** Relative time from the row's activity timestamp ("2 min. ago"). */
    fun activityDescription(
        t: LocalTerminal,
        now: Instant,
    ): String = (t.lastActivityAt ?: t.updatedAt).relativeDescription(now)

    /** `/Users/dev/acme` → `~/acme` (web `shortDir`). */
    fun shortDir(dir: String?): String? {
        if (dir.isNullOrEmpty()) return null
        val match = HOME_PREFIX.find(dir) ?: return dir
        return "~" + dir.substring(match.range.last + 1)
    }

    /** `https://github.com/acme/web.git` → `acme/web` (web `shortRepo`). */
    fun shortRepo(url: String?): String? {
        if (url.isNullOrEmpty()) return null
        return url.replaceFirst(HOST_PREFIX, "").removeSuffix(".git")
    }

    private val HOME_PREFIX = Regex("^/Users/[^/]+|^/home/[^/]+")
    private val HOST_PREFIX = Regex("^https?://[^/]+/")
}

/** Copy-with for the few fields the stream updates locally (iOS `LocalTerminal(copy:…)`). */
fun LocalTerminal.withLive(
    state: LocalTerminalState = this.state,
    attentionState: LocalAttentionState = this.attentionState,
    exitCode: Double? = this.exitCode,
): LocalTerminal = copy(state = state, attentionState = attentionState, exitCode = exitCode)
