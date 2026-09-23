package dev.optio.core.glance

import java.time.Instant
import kotlin.time.Duration
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.toKotlinDuration

/**
 * Pure decisions behind the glanceable surfaces: refresh cadence, staleness, snooze ordering and
 * the Run widget's "started" flash (port of iOS `OptioWidgets/Widgets/GlancePolicy.swift`).
 */
object GlancePolicy {
    /** How the last load went; drives cadence and the widget's honesty footer. */
    enum class Reachability { SIGNED_OUT, UNREACHABLE, LIVE }

    /**
     * Refresh interval:
     * - 5 min while anything is running or waiting on you (the number people watch),
     * - 15 min when quiet,
     * - 60 min when signed out or the laptop is unreachable (nothing to gain by polling).
     */
    fun refreshInterval(
        reachability: Reachability,
        anyRunning: Boolean,
        anyNeedsYou: Boolean,
    ): Duration =
        when (reachability) {
            Reachability.SIGNED_OUT, Reachability.UNREACHABLE -> 60.minutes
            Reachability.LIVE -> if (anyRunning || anyNeedsYou) 5.minutes else 15.minutes
        }

    /** Past this age a surface shows its `asOf` time instead of pretending to be live. */
    val STALE_AFTER: Duration = 20.minutes

    fun isStale(
        asOf: Instant,
        now: Instant,
    ): Boolean = elapsed(asOf, now) > STALE_AFTER

    /**
     * Snoozed ("Later") items keep their place in the data but move to the back of the queue for
     * the snooze window. Order within each group is preserved; expired snoozes are ignored.
     */
    fun <T> applySnooze(
        items: List<T>,
        id: (T) -> String,
        snoozedUntil: Map<String, Instant>,
        now: Instant,
    ): List<T> {
        fun snoozed(item: T): Boolean = snoozedUntil[id(item)]?.isAfter(now) == true
        return items.filterNot(::snoozed) + items.filter(::snoozed)
    }

    /** The Run widget / tile shows "Started · Xs ago" for this long after firing. */
    val STARTED_FLASH: Duration = 60.seconds

    fun showsStarted(
        lastStartedAt: Instant?,
        now: Instant,
    ): Boolean {
        if (lastStartedAt == null) return false
        val age = elapsed(lastStartedAt, now)
        return !age.isNegative() && age < STARTED_FLASH
    }

    /** A two-tap confirmation for the Run widget: the first tap arms it for this long. */
    val ARM_WINDOW: Duration = 10.seconds

    fun isArmed(
        armedAt: Instant?,
        now: Instant,
    ): Boolean {
        if (armedAt == null) return false
        val age = elapsed(armedAt, now)
        return !age.isNegative() && age < ARM_WINDOW
    }

    /** Compact wait time for rows and small surfaces: "now", "4m", "2h", "3d" (never seconds). */
    fun waitText(
        since: Instant,
        now: Instant,
    ): String {
        val s = maxOf(Duration.ZERO, elapsed(since, now))
        return when {
            s < 1.minutes -> "now"
            s < 1.hours -> "${s.inWholeMinutes}m"
            s < 24.hours -> "${s.inWholeHours}h"
            else -> "${s.inWholeDays}d"
        }
    }

    private fun elapsed(
        from: Instant,
        to: Instant,
    ): Duration = java.time.Duration.between(from, to).toKotlinDuration()
}
