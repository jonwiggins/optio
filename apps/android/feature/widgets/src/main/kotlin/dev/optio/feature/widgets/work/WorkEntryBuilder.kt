package dev.optio.feature.widgets.work

import androidx.datastore.preferences.core.Preferences
import dev.optio.core.data.ServerProfile
import dev.optio.feature.widgets.data.CachedSlice
import dev.optio.feature.widgets.data.WidgetStore
import dev.optio.feature.widgets.model.GlanceEntry
import dev.optio.feature.widgets.model.GlancePolicy
import dev.optio.feature.widgets.model.GlanceSlice
import java.time.Instant

/**
 * Builds a widget's [GlanceEntry] from the cached per-server loads (iOS
 * `GlanceTimelineProvider.load`, minus the network: the refresher fills the cache).
 */
internal object WorkEntryBuilder {
    /**
     * [servers] are the paired servers (active first); [serverFilter] the widget's Server option
     * (null = all). A chosen server that is no longer paired falls back to all of them, like iOS.
     */
    fun build(
        servers: List<ServerProfile>,
        prefs: Preferences,
        serverFilter: String?,
        now: Instant,
    ): GlanceEntry {
        if (servers.isEmpty()) return GlanceEntry.signedOut(now)
        val shown = serverFilter?.let { id -> servers.filter { it.id == id } }?.takeIf { it.isNotEmpty() } ?: servers
        return GlanceEntry(
            date = now,
            slices = shown.map { slice(it, WidgetStore.cached(prefs, it.id), prefs, now) },
            othersPaired = servers.size > shown.size,
        )
    }

    /**
     * One server's slice: its cached snapshot ordered for the widget (needs-you oldest first with
     * "Later" items at the back, running newest first) and trusted per its last load. A server
     * never loaded yet reads as live and empty (the refresh that placing the widget starts fills it).
     */
    fun slice(
        server: ServerProfile,
        cached: CachedSlice?,
        prefs: Preferences,
        now: Instant,
    ): GlanceSlice {
        if (cached == null) {
            return GlanceSlice(server, GlancePolicy.Reachability.LIVE, emptyList(), emptyList(), asOf = now)
        }
        val needs = cached.needsYou.map { it.toItem() }.sortedBy { it.since }
        val snoozes = WidgetStore.snoozedUntil(prefs, needs.map { it.id })
        val ordered =
            GlancePolicy.applySnooze(needs, { it.id }, snoozes, now).map { item ->
                // Mirror a local "Later" onto the item so merged (multi-server) ordering sees it too.
                val local = snoozes[item.id]
                if (local != null && local.isAfter(now) && (item.snoozedUntil ?: Instant.MIN) < local) item.copy(snoozedUntil = local) else item
            }
        return GlanceSlice(
            server = server,
            reachability = if (cached.unreachableSince == null) GlancePolicy.Reachability.LIVE else GlancePolicy.Reachability.UNREACHABLE,
            needsYou = ordered,
            running = cached.running.map { it.toItem() }.sortedByDescending { it.since },
            counts = cached.counts,
            asOf = cached.asOf,
            tasks = cached.tasks,
            unreachableSince = cached.unreachableSince,
        )
    }
}
