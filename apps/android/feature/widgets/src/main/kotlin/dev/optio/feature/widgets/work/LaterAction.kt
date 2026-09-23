package dev.optio.feature.widgets.work

import android.content.Context
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.action.ActionCallback
import dev.optio.core.glance.GlanceRefresh
import dev.optio.core.model.WatchItemKind
import dev.optio.feature.widgets.Host
import dev.optio.feature.widgets.run.attempt
import java.time.Duration
import java.time.Instant

/**
 * **Later** on a needs-you row (iOS `LaterIntent` / `WatchActions.snooze`), run in the background
 * without opening the app: the item drops to the back of the queue for 15 minutes. The local
 * mirror is written first, so every phone surface agrees even when the request fails; a Local
 * terminal is also snoozed server-side (`POST /api/local/terminals/:id/snooze`), on the row's own
 * server.
 */
class LaterAction : ActionCallback {
    override suspend fun onAction(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters,
    ) {
        val id = parameters[itemId] ?: return
        snooze(context, id, parameters[kind], parameters[serverId]?.takeIf { it.isNotEmpty() })
    }

    companion object {
        val itemId = ActionParameters.Key<String>("optio.later.item")
        val kind = ActionParameters.Key<String>("optio.later.kind")
        val serverId = ActionParameters.Key<String>("optio.later.server")

        /** Snooze length (iOS: 15 minutes). */
        val window: Duration = Duration.ofMinutes(15)

        internal suspend fun snooze(
            context: Context,
            id: String,
            kind: String?,
            serverId: String?,
        ) {
            // The shared "Later" (the Watch notification and the tiles read it too), then the server's.
            Host.store(context).snooze(id, Instant.now().plus(window))
            if (kind == WatchItemKind.LOCAL.raw) {
                val client = Host.session()?.resolveClient(serverId)
                attempt { client?.api?.post("/api/local/terminals/$id/snooze", body = mapOf("minutes" to window.toMinutes())) }
            }
            // Re-renders the widgets and tiles (this module's hook) and the other glance surfaces.
            GlanceRefresh.refreshAll(context, GlanceRefresh.Reason.ACTION)
        }
    }
}
