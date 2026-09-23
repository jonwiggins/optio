package dev.optio.core.ui.usage

import androidx.compose.runtime.Immutable
import dev.optio.core.model.AgentLimitWindow
import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalHostAgentLimits
import dev.optio.core.ui.format.isoInstant
import dev.optio.core.ui.theme.Tone
import java.time.Instant
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.roundToInt

// Pure projection of "how far along am I on each agent subscription" (iOS `ProviderLimits.swift`),
// a port of `collectProviderLimits` / `windowLabel` / `resetsIn` in
// `apps/web/src/components/dashboard/limits-panel.tsx` and the bucket helpers in
// `apps/web/src/components/local/usage-chips.tsx`. No Compose here so it is unit-tested directly.

/** One rate-limit window as the panel draws it. */
@Immutable
data class LimitWindow(
    /** 0–100 (clamped when drawn). */
    val usedPercent: Double,
    val resetsAt: String? = null,
    val windowMinutes: Double? = null,
)

/** One provider's block in the limits panel. */
@Immutable
data class ProviderLimits(
    val key: Key,
    val name: String,
    /** Where the number comes from, for the footnote. */
    val source: String,
    /** Null = live; otherwise the instant the snapshot was taken. */
    val observedAt: String?,
    val planType: String?,
    val windows: List<Window>,
) {
    enum class Key { CLAUDE, CODEX }

    @Immutable
    data class Window(val label: String, val window: LimitWindow)
}

object UsageLimits {
    /** Labels a window by its length: 300 → "5h", 10080 → "7d", 90 → "90m"; unknown → [fallback]. */
    fun windowLabel(minutes: Double?, fallback: String): String {
        if (minutes == null || !(minutes > 0)) return fallback
        val m = minutes.toInt()
        if (m % 1440 == 0) return "${m / 1440}d"
        if (m % 60 == 0) return "${m / 60}h"
        return "${m}m"
    }

    /**
     * The Claude buckets worth a header slot: 5h, 7d, then one "7d <Model>" per model-scoped weekly
     * cap (`accountBuckets` in usage-chips.tsx).
     */
    fun claudeBuckets(usage: ClaudeUsageData): List<ProviderLimits.Window> = buildList {
        usage.fiveHour?.let { w -> w.utilization?.let { add(ProviderLimits.Window("5h", LimitWindow(it, w.resetsAt))) } }
        usage.sevenDay?.let { w -> w.utilization?.let { add(ProviderLimits.Window("7d", LimitWindow(it, w.resetsAt))) } }
        usage.sevenDayModels.orEmpty().forEach { m ->
            m.utilization?.let { add(ProviderLimits.Window("7d ${m.model}", LimitWindow(it, m.resetsAt))) }
        }
    }

    /**
     * Folds Claude's live account usage and every host's Codex snapshot (the freshest wins) into a
     * uniform list for the panel, Claude first.
     */
    fun collectProviderLimits(usage: ClaudeUsageData?, hosts: List<LocalHost>, now: Instant = Instant.now()): List<ProviderLimits> {
        val out = mutableListOf<ProviderLimits>()
        if (usage != null && usage.available) {
            val windows = claudeBuckets(usage)
            if (windows.isNotEmpty()) {
                out += ProviderLimits(ProviderLimits.Key.CLAUDE, "Claude", "account, live", observedAt = null, planType = null, windows = windows)
            }
        }
        var codex: LocalHostAgentLimits.Codex? = null
        for (host in hosts) {
            val c = host.agentLimits?.codex ?: continue
            // ISO-8601 strings from the same clock compare lexically, as the web does.
            if (codex == null || c.observedAt > codex.observedAt) codex = c
        }
        if (codex != null) {
            val windows = mutableListOf<ProviderLimits.Window>()
            fun add(w: AgentLimitWindow?, fallback: String) {
                if (w == null) return
                // A window that has since reset reads 0 — no point showing stale use.
                val reset = w.resetsAt?.isoInstant()?.isBefore(now) ?: false
                windows += ProviderLimits.Window(
                    windowLabel(w.windowMinutes, fallback),
                    LimitWindow(
                        usedPercent = if (reset) 0.0 else w.usedPercent,
                        resetsAt = if (reset) null else w.resetsAt,
                        windowMinutes = w.windowMinutes,
                    ),
                )
            }
            add(codex.primary, "5h")
            add(codex.secondary, "7d")
            if (windows.isNotEmpty()) {
                out += ProviderLimits(
                    ProviderLimits.Key.CODEX,
                    "Codex",
                    "from its session log on your machine",
                    observedAt = codex.observedAt,
                    planType = codex.planType,
                    windows = windows,
                )
            }
        }
        return out
    }

    /** "5h 12m", "3d 4h", "45m"; null once the window has passed (or is unknown). */
    fun resetsIn(resetsAt: String?, now: Instant = Instant.now()): String? {
        val date = resetsAt?.isoInstant() ?: return null
        val diff = (date.toEpochMilli() - now.toEpochMilli()) / 1000.0
        if (!(diff > 0)) return null
        val h = (diff / 3600).toInt()
        val m = ((diff % 3600) / 60).toInt()
        if (h >= 24) return "${h / 24}d ${h % 24}h"
        return if (h > 0) "${h}h ${m}m" else "${m}m"
    }

    /** Whole percent in 0…100 (Swift `.rounded()`, half away from zero): what every meter prints. */
    fun percent(value: Double?): Int {
        val v = value ?: 0.0
        val rounded = if (v < 0) -floor(-v + 0.5) else floor(v + 0.5)
        return rounded.coerceIn(0.0, 100.0).toInt()
    }

    /** Coarse "how old are these numbers" for the stale note (`staleAge`). */
    fun staleAge(asOf: String, now: Instant = Instant.now()): String {
        val date = asOf.isoInstant() ?: return asOf
        val mins = max(0, ((now.toEpochMilli() - date.toEpochMilli()) / 60_000.0).roundToInt())
        if (mins < 1) return "under a minute"
        if (mins < 60) return "${mins}m"
        val h = mins / 60
        val m = mins % 60
        return if (m > 0) "${h}h ${m}m" else "${h}h"
    }
}

/**
 * Meter / pill colour by how close a window is to its cap (the web's `tone` and `pctTone`): green
 * under 50, purple to 80, yellow to 95, red above.
 */
enum class UsageSeverity {
    LOW,
    NORMAL,
    WARNING,
    CRITICAL,
    ;

    /** Whether the number should stand out from body text (pill text, meter percent). */
    val isElevated: Boolean
        get() = this == WARNING || this == CRITICAL

    /** The web's `tone`: success under 50, primary to 80, warning to 95, error above. */
    val tone: Tone
        get() = when (this) {
            LOW -> Tone.SUCCESS
            NORMAL -> Tone.WORKING
            WARNING -> Tone.ACCENT
            CRITICAL -> Tone.DANGER
        }

    companion object {
        fun of(percent: Int): UsageSeverity = when {
            percent >= 95 -> CRITICAL
            percent >= 80 -> WARNING
            percent >= 50 -> NORMAL
            else -> LOW
        }
    }
}
