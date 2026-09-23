package dev.optio.feature.glance.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import dev.optio.feature.glance.GlanceRuntime
import dev.optio.feature.glance.watch.WatchNotifier
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Receives the notification buttons that call the API without opening the app (Reply, Later,
 * Resume, Retry) and hands them to [NotificationHandler], within the ~10 s a receiver may run.
 * Also: the Watch was swiped away, and "Stop watching" on the keep-watching notification.
 */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(
        context: Context,
        intent: Intent,
    ) {
        val runtime = GlanceRuntime.get(context)
        when (intent.action) {
            WatchNotifier.ACTION_DISMISSED -> {
                val pending = goAsync()
                runtime.scope.launch {
                    try {
                        runtime.watch.userDismissed()
                    } finally {
                        pending.finish()
                    }
                }
                return
            }
            WatchNotifier.ACTION_STOP_KEEP_WATCHING -> {
                val pending = goAsync()
                runtime.scope.launch {
                    try {
                        runtime.keepWatching.set(false)
                    } finally {
                        pending.finish()
                    }
                }
                return
            }
        }
        val action = NotificationAction.of(intent.action?.removePrefix(NotificationActions.INTENT_PREFIX)) ?: return
        val target = ActionTarget.from(intent) ?: return
        val reply = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(AlertNotifier.REPLY_KEY)?.toString()
        val pending = goAsync()
        runtime.scope.launch {
            try {
                withTimeoutOrNull(BUDGET) { runtime.handler.perform(action, target, reply) }
            } finally {
                pending.finish()
            }
        }
    }

    private companion object {
        // Receivers get ~10 s after goAsync(); leave room to finish.
        val BUDGET = 9.seconds
    }
}
