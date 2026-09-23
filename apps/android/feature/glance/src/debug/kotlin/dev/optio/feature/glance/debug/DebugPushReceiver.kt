package dev.optio.feature.glance.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import dev.optio.core.model.OptioJson
import dev.optio.feature.glance.GlanceRuntime
import dev.optio.feature.glance.push.FirebaseTokenSource
import dev.optio.feature.glance.refresh.GlanceWork
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/**
 * Debug builds: drives the push paths from adb, without Firebase (no project exists for dev).
 *
 * ```
 * # A data message exactly as FCM would deliver it (e.g. a line of OPTIO_FCM_FAKE_OUTBOX's `data`):
 * adb shell am broadcast -a dev.optio.android.DEBUG_PUSH --es data '{"type":"alert",…}'
 * # A fake registration token, then register it with every paired server:
 * adb shell am broadcast -a dev.optio.android.DEBUG_FCM_TOKEN --es token fake-token-…
 * # One background check now (the WorkManager job):
 * adb shell am broadcast -a dev.optio.android.DEBUG_GLANCE_CHECK
 * # Follow a task on the Watch:
 * adb shell am broadcast -a dev.optio.android.DEBUG_FOLLOW_TASK --es id <taskId>
 * ```
 */
class DebugPushReceiver : BroadcastReceiver() {
    override fun onReceive(
        context: Context,
        intent: Intent,
    ) {
        val runtime = GlanceRuntime.get(context)
        val pending = goAsync()
        runtime.scope.launch {
            try {
                when (intent.action) {
                    "dev.optio.android.DEBUG_PUSH" -> {
                        val raw = intent.getStringExtra("data") ?: return@launch
                        val obj = OptioJson.parseToJsonElement(raw).jsonObject
                        val data = obj.mapValues { (_, v) -> (v as? JsonPrimitive)?.content ?: v.toString() }
                        Log.i(TAG, "push → ${runtime.push.handle(data)}")
                    }
                    "dev.optio.android.DEBUG_FCM_TOKEN" -> {
                        val token = intent.getStringExtra("token")
                        context.getSharedPreferences(FirebaseTokenSource.DEBUG_PREFS, Context.MODE_PRIVATE)
                            .edit().putString(FirebaseTokenSource.DEBUG_TOKEN, token).commit()
                        runtime.registrar.sync()
                        Log.i(TAG, "registration → ${runtime.status.state.value.servers}")
                    }
                    "dev.optio.android.DEBUG_GLANCE_CHECK" -> {
                        GlanceWork.runNow(context)
                        Log.i(TAG, "background check enqueued")
                    }
                    "dev.optio.android.DEBUG_FOLLOW_TASK" -> {
                        val id = intent.getStringExtra("id") ?: return@launch
                        runtime.sources.follow(id)
                        Log.i(TAG, "following $id")
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "debug action ${intent.action} failed", e)
            } finally {
                pending.finish()
            }
        }
    }

    private companion object {
        const val TAG = "OptioDebugPush"
    }
}
