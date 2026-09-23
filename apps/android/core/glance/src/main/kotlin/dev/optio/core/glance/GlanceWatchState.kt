@file:UseSerializers(FlexibleInstantSerializer::class)

package dev.optio.core.glance

import dev.optio.core.model.FlexibleInstantSerializer
import dev.optio.core.model.WatchPhase
import dev.optio.core.model.WatchState
import java.time.Instant
import kotlin.math.roundToInt
import kotlinx.serialization.Serializable
import kotlinx.serialization.UseSerializers

/**
 * The Watch's content: "the thing waiting on you, plus how many more" (port of the iOS
 * `WatchState`, the Live Activity content state). The generated wire [WatchState] is what the
 * server sends (FCM `watch` frames, `GET /api/glance/watch`); this is the app-side state with
 * [Instant]s and server-tagged [GlanceItem]s, which [merge] folds across paired servers.
 */
@Serializable
data class GlanceWatchState(
    val phase: WatchPhase,
    /** Oldest item needing you (when [WatchPhase.WAITING]) or most recent running item (when working). */
    val head: GlanceItem? = null,
    /** Up to two further items needing you; small surfaces only show [head]. */
    val others: List<GlanceItem> = emptyList(),
    /** Total items needing you, including [head] and beyond [others]. */
    val needsYouCount: Int = 0,
    val runningCount: Int = 0,
    /** Sessions halted at their prompt / an open PR (server tile; null from older servers). */
    val waitingCount: Int? = null,
    /** Enabled recurring definitions (server tile; null from older servers). */
    val recurringCount: Int? = null,
    /** Persistent agents not archived (server tile; null from older servers). */
    val agentCount: Int? = null,
    val offlineSince: Instant? = null,
    /** Wrap-up line of the final `done` frame. */
    val summary: String? = null,
    /** When the state was computed; drives "as of" and frame ordering. */
    val asOf: Instant = Instant.now(),
) {
    /** Something to show: a session needs you, or sessions are running. */
    val hasWork: Boolean
        get() = phase == WatchPhase.WAITING || (phase == WatchPhase.WORKING && runningCount > 0)

    /** [head] and [others], in order. */
    val items: List<GlanceItem>
        get() = listOfNotNull(head) + others

    /** The wire frame (Apple-second dates, no server fields). */
    fun toWire(): WatchState =
        WatchState(
            phase = phase,
            head = head?.toWire(),
            others = others.map { it.toWire() },
            needsYouCount = needsYouCount.toDouble(),
            runningCount = runningCount.toDouble(),
            waitingCount = waitingCount?.toDouble(),
            recurringCount = recurringCount?.toDouble(),
            agentCount = agentCount?.toDouble(),
            offlineSince = offlineSince?.appleSeconds,
            summary = summary,
            asOf = asOf.appleSeconds,
        )

    /**
     * Everything that changes what the user sees, without [asOf] (iOS `contentHash`): two states
     * with the same key need no re-render.
     */
    val contentKey: GlanceWatchState
        get() = copy(asOf = Instant.EPOCH)

    companion object {
        /** Nothing running, nothing waiting. */
        val QUIET = GlanceWatchState(phase = WatchPhase.WORKING, asOf = Instant.EPOCH)

        /** How many further items needing you a frame lists beside the head. */
        const val OTHERS_MAX = 2

        /** A wire frame from one server, its items tagged with [serverId] / [serverName]. */
        fun fromWire(
            wire: WatchState,
            serverId: String? = null,
            serverName: String? = null,
        ): GlanceWatchState =
            GlanceWatchState(
                phase = wire.phase,
                head = wire.head?.let { GlanceItem.from(it, serverId, serverName) },
                others = wire.others.map { GlanceItem.from(it, serverId, serverName) },
                needsYouCount = wire.needsYouCount.roundToInt(),
                runningCount = wire.runningCount.roundToInt(),
                waitingCount = wire.waitingCount?.roundToInt(),
                recurringCount = wire.recurringCount?.roundToInt(),
                agentCount = wire.agentCount?.roundToInt(),
                offlineSince = wire.offlineSince?.let(AppleTime::toInstant),
                summary = wire.summary,
                asOf = AppleTime.toInstant(wire.asOf),
            )

        /**
         * One Watch from several servers' frames (the Android Watch shows every paired server,
         * like the iOS one). Each frame's head + others are its oldest needs-you rows, so the
         * merged head and others are exact: the oldest unsnoozed needs-you row across servers
         * leads, the next [OTHERS_MAX] follow. Counts and tiles add up (a tile stays null only
         * when no frame has it). Phase: waiting when anything needs you, else working when
         * anything runs, else offline when a server is unreachable, else done. The newest
         * [asOf] wins; a single frame is returned as is.
         */
        fun merge(
            frames: List<GlanceWatchState>,
            now: Instant = Instant.now(),
        ): GlanceWatchState {
            if (frames.isEmpty()) return QUIET.copy(asOf = now)
            if (frames.size == 1) return frames[0]
            val live = frames.filter { it.phase == WatchPhase.WAITING || it.phase == WatchPhase.WORKING }
            val sorted = live.filter { it.phase == WatchPhase.WAITING }.flatMap { it.items }.sortedWith(needsYouOrder(now))
            val needsYou = live.sumOf { if (it.phase == WatchPhase.WAITING) it.needsYouCount else 0 }
            val running = live.sumOf { it.runningCount }
            val offline = frames.filter { it.phase == WatchPhase.OFFLINE }
            val phase =
                when {
                    sorted.isNotEmpty() -> WatchPhase.WAITING
                    running > 0 -> WatchPhase.WORKING
                    offline.isNotEmpty() -> WatchPhase.OFFLINE
                    frames.all { it.phase == WatchPhase.DONE } -> WatchPhase.DONE
                    else -> WatchPhase.WORKING
                }
            val head =
                when (phase) {
                    WatchPhase.WAITING -> sorted.first()
                    WatchPhase.WORKING -> live.filter { it.phase == WatchPhase.WORKING }.mapNotNull { it.head }.maxByOrNull { it.since }
                    WatchPhase.OFFLINE -> offline.firstNotNullOfOrNull { it.head }
                    else -> null
                }
            fun sumTile(pick: (GlanceWatchState) -> Int?): Int? = frames.mapNotNull(pick).takeIf { it.isNotEmpty() }?.sum()
            val offlineOnly = phase == WatchPhase.OFFLINE
            return GlanceWatchState(
                phase = phase,
                head = head,
                others = if (phase == WatchPhase.WAITING) sorted.drop(1).take(OTHERS_MAX) else emptyList(),
                needsYouCount = if (offlineOnly) offline.sumOf { it.needsYouCount } else needsYou,
                runningCount = if (offlineOnly) offline.sumOf { it.runningCount } else running,
                waitingCount = sumTile { it.waitingCount },
                recurringCount = sumTile { it.recurringCount },
                agentCount = sumTile { it.agentCount },
                offlineSince = offline.mapNotNull { it.offlineSince }.minOrNull(),
                summary = if (phase == WatchPhase.DONE) frames.firstNotNullOfOrNull { it.summary } else null,
                asOf = frames.maxOf { it.asOf },
            )
        }

        /** Needs-you order: unsnoozed first, then oldest first (iOS `watchState()`). */
        fun needsYouOrder(now: Instant): Comparator<GlanceItem> =
            compareBy<GlanceItem> { it.isSnoozed(now) }.thenBy { it.since }
    }
}

/** The three board tiles the items alone cannot tell (`countSessions` on the web). */
@Serializable
data class SessionTileCounts(
    val waiting: Int,
    val recurring: Int,
    val agents: Int,
) {
    companion object {
        /** Sum across servers; null only when neither side has tiles. */
        fun sum(
            a: SessionTileCounts?,
            b: SessionTileCounts?,
        ): SessionTileCounts? =
            when {
                a == null -> b
                b == null -> a
                else -> SessionTileCounts(a.waiting + b.waiting, a.recurring + b.recurring, a.agents + b.agents)
            }
    }
}
