package dev.optio.feature.glance.push

import android.util.Log
import dev.optio.core.glance.GlanceRefresh
import dev.optio.core.model.AndroidPushAlert
import dev.optio.core.model.AndroidPushMessage
import dev.optio.core.model.AndroidPushWatch
import dev.optio.core.model.OptioJson
import dev.optio.core.model.WatchState
import dev.optio.feature.glance.notifications.AlertNotifier
import dev.optio.feature.glance.notifications.AlertSpec
import dev.optio.feature.glance.watch.WatchManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Handles one FCM data message (`remoteMessage.data`, every value a string): decodes it as the
 * generated [AndroidPushMessage] and either posts the alert or applies the Watch frame. Every
 * HIGH-priority message ends in a visible notification: alerts always post; an alerting Watch frame
 * is a "waiting" frame, which shows the Watch.
 */
class PushMessageHandler(
    private val alerts: AlertNotifier,
    private val watch: WatchManager,
    private val scope: CoroutineScope,
    /** Finds the paired server that has a subject when an alert names none (several servers paired). */
    private val resolveServer: suspend (kind: String, id: String) -> String? = { _, _ -> null },
    private val refreshSurfaces: suspend (GlanceRefresh.Reason) -> Unit = {},
) {
    /** What a message turned into. */
    sealed interface Result {
        data class Alert(
            val spec: AlertSpec,
            val posted: Boolean,
        ) : Result

        data class Watch(
            val result: WatchManager.FrameResult,
        ) : Result

        /** A `type` this build does not know. */
        data object Unknown : Result

        /** Not an Optio message, or a malformed one. */
        data object Malformed : Result
    }

    suspend fun handle(data: Map<String, String>): Result {
        val message = decode(data) ?: return Result.Malformed
        return when (message) {
            is AndroidPushAlert -> {
                val spec = AlertSpec.from(message)
                val posted = alerts.post(spec)
                if (spec.serverId == null) {
                    // Older servers (or a token registered without a serverId): find the subject's
                    // server so the tap and the actions land there; re-post quietly with it.
                    scope.launch {
                        val found = runCatching { resolveServer(spec.kind, spec.id) }.getOrNull()
                        if (found != null) alerts.post(spec.copy(serverId = found, audible = false))
                    }
                }
                runCatching { refreshSurfaces(GlanceRefresh.Reason.PUSH) }
                Result.Alert(spec, posted)
            }
            is AndroidPushWatch -> {
                val state =
                    try {
                        OptioJson.decodeFromString(WatchState.serializer(), message.state)
                    } catch (e: SerializationException) {
                        Log.w(TAG, "undecodable Watch frame", e)
                        return Result.Malformed
                    } catch (e: IllegalArgumentException) {
                        Log.w(TAG, "undecodable Watch frame", e)
                        return Result.Malformed
                    }
                Result.Watch(watch.applyFrame(message.serverId, message.event, state))
            }
            is AndroidPushMessage.Unknown -> Result.Unknown
        }
    }

    companion object {
        private const val TAG = "OptioPush"

        /** `remoteMessage.data` as the generated union; null when it is not an Optio message. */
        fun decode(data: Map<String, String>): AndroidPushMessage? {
            if (data.isEmpty()) return null
            return try {
                OptioJson.decodeFromJsonElement(AndroidPushMessage.serializer(), JsonObject(data.mapValues { JsonPrimitive(it.value) }))
            } catch (e: SerializationException) {
                Log.w(TAG, "undecodable push", e)
                null
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "undecodable push", e)
                null
            }
        }
    }
}
