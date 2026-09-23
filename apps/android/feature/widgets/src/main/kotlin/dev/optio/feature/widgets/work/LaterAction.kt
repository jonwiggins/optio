package dev.optio.feature.widgets.work

import android.content.Context
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.action.ActionCallback
import dev.optio.core.glance.GlanceActions

/**
 * **Later** on a needs-you row (iOS `LaterIntent`), run in the background without opening the app:
 * the item drops to the back of the queue for 15 minutes. Shared with the Watch notification's
 * Later (`GlanceActions.later`): the local snooze first, so every phone surface agrees even when
 * the request fails; a Local terminal is also snoozed server-side on the row's own server; then
 * every glance surface re-renders.
 */
class LaterAction : ActionCallback {
    override suspend fun onAction(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters,
    ) {
        val id = parameters[itemId] ?: return
        GlanceActions.later(context, kind = parameters[kind].orEmpty(), id = id, serverId = parameters[serverId]?.takeIf { it.isNotEmpty() })
    }

    companion object {
        val itemId = ActionParameters.Key<String>("optio.later.item")
        val kind = ActionParameters.Key<String>("optio.later.kind")
        val serverId = ActionParameters.Key<String>("optio.later.server")
    }
}
