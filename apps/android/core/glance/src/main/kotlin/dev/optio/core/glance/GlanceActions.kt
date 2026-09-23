package dev.optio.core.glance

import android.content.Context
import dev.optio.core.data.ServerClient
import java.time.Duration
import java.time.Instant
import kotlinx.serialization.Serializable

/**
 * The actions glanceable surfaces run without opening the app (port of iOS `WatchActions`, shared by
 * the Live Activity and the widgets): "Later" and a task's Resume / Retry. Each talks to the item's
 * own server (`serverId`; null = the active server) and then announces the change
 * ([GlanceRefresh], reason ACTION) so the Watch, widgets and tiles re-render.
 *
 * ```
 * GlanceActions.later(context, kind = "local", id = item.id, serverId = item.serverId)   // a widget button
 * ```
 */
object GlanceActions {
    /** "Later" lasts this long (iOS `SnoozeStore.defaultMinutes`). */
    const val SNOOZE_MINUTES = 15

    /**
     * "Later": a local snooze (so this phone's surfaces agree at once, even offline) plus the
     * server-side snooze for a Local terminal (`POST /api/local/terminals/:id/snooze`, so the web
     * and other devices agree too). Never throws: "Later" must always work from a button.
     *
     * @return true when the server took it (false: local only).
     */
    suspend fun later(
        store: GlanceStore,
        client: ServerClient?,
        kind: String,
        id: String,
        minutes: Int = SNOOZE_MINUTES,
        now: Instant = Instant.now(),
    ): Boolean {
        store.snooze(id, now.plus(Duration.ofMinutes(minutes.toLong())))
        if (kind != "local" || client == null) return false
        return runCatching { client.api.post("/api/local/terminals/$id/snooze", body = SnoozeBody(minutes)) }.isSuccess
    }

    /** [later] on the item's server, then refreshes every surface. */
    suspend fun later(
        context: Context,
        kind: String,
        id: String,
        serverId: String?,
    ): Boolean {
        val done = later(GlanceStore.get(context), GlanceHost.session?.resolveClient(serverId), kind, id)
        GlanceRefresh.refreshAll(context, GlanceRefresh.Reason.ACTION)
        return done
    }

    /** `POST /api/tasks/:id/resume` (no new prompt). Throws `ApiError` on failure. */
    suspend fun resumeTask(
        client: ServerClient,
        id: String,
    ) = client.api.post("/api/tasks/$id/resume", body = emptyMap<String, String>())

    /** `POST /api/tasks/:id/retry`. Throws `ApiError` on failure. */
    suspend fun retryTask(
        client: ServerClient,
        id: String,
    ) = client.api.post("/api/tasks/$id/retry")

    /** Resume or retry a task on its server, then refresh every surface; false when it failed. */
    suspend fun taskAction(
        context: Context,
        id: String,
        serverId: String?,
        retry: Boolean,
    ): Boolean {
        val client = GlanceHost.session?.resolveClient(serverId) ?: return false
        val ok = runCatching { if (retry) retryTask(client, id) else resumeTask(client, id) }.isSuccess
        GlanceRefresh.refreshAll(context, GlanceRefresh.Reason.ACTION)
        return ok
    }

    @Serializable
    private data class SnoozeBody(
        val minutes: Int,
    )
}
