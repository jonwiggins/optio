package dev.optio.feature.widgets.debug

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.lifecycle.lifecycleScope
import dev.optio.core.glance.RunTarget
import dev.optio.core.model.OptioJson
import dev.optio.feature.widgets.OptioWidgets
import dev.optio.feature.widgets.refresh.WidgetRefreshWorker
import dev.optio.feature.widgets.run.RunWidget
import dev.optio.feature.widgets.run.RunWidgetReceiver
import dev.optio.feature.widgets.work.WorkWidget
import dev.optio.feature.widgets.work.WorkWidgetReceiver
import kotlinx.coroutines.launch

/**
 * Debug builds only: asks the launcher to pin a widget (`AppWidgetManager.requestPinAppWidget`),
 * so emulator checks can place one from adb; the launcher's dialog still needs its Add tap.
 *
 * ```
 * adb shell am start -n dev.optio.android/dev.optio.feature.widgets.debug.PinWidgetActivity \
 *   --es kind work [--es server dev-server]
 * adb shell am start -n dev.optio.android/dev.optio.feature.widgets.debug.PinWidgetActivity \
 *   --es kind run [--es target 'dev-server|job:<uuid>' --es name 'Nightly release notes' --ez confirm false]
 * ```
 *
 * A widget pinned from an app skips the launcher's setup screen, so the extras (if any) configure
 * the new widget when it lands ([PinnedWidgetReceiver]); a Run widget without them asks for its
 * target on the first tap.
 */
class PinWidgetActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val kind = intent.getStringExtra(EXTRA_KIND) ?: "work"
        val receiver = if (kind == "run") RunWidgetReceiver::class.java else WorkWidgetReceiver::class.java
        val callback =
            Intent(this, PinnedWidgetReceiver::class.java)
                .putExtra(EXTRA_KIND, kind)
                .putExtras(intent.extras ?: Bundle())
        // Mutable: the launcher adds EXTRA_APPWIDGET_ID when the widget lands.
        val pending = PendingIntent.getBroadcast(this, kind.hashCode(), callback, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        lifecycleScope.launch {
            val asked = GlanceAppWidgetManager(this@PinWidgetActivity).requestPinGlanceAppWidget(receiver, successCallback = pending)
            Log.i(TAG, "requestPin($kind) = $asked")
            if (!asked) Toast.makeText(this@PinWidgetActivity, "This launcher can't pin widgets.", Toast.LENGTH_SHORT).show()
            finish()
        }
    }

    companion object {
        const val TAG = "OptioWidgetsDebug"
        const val EXTRA_KIND = "kind"
        const val EXTRA_SERVER = "server"
        const val EXTRA_TARGET = "target"
        const val EXTRA_NAME = "name"
        const val EXTRA_CONFIRM = "confirm"
    }
}

/** Configures a widget pinned by [PinWidgetActivity] from the extras it was asked with. */
class PinnedWidgetReceiver : BroadcastReceiver() {
    override fun onReceive(
        context: Context,
        intent: Intent,
    ) {
        val appWidgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        Log.i(PinWidgetActivity.TAG, "pinned ${intent.getStringExtra(PinWidgetActivity.EXTRA_KIND)} widget $appWidgetId")
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return
        val app = context.applicationContext
        val pending = goAsync()
        OptioWidgets.scope.launch {
            try {
                val glanceId = GlanceAppWidgetManager(app).getGlanceIdBy(appWidgetId)
                if (intent.getStringExtra(PinWidgetActivity.EXTRA_KIND) == "run") {
                    val id = intent.getStringExtra(PinWidgetActivity.EXTRA_TARGET)
                    val parts = id?.let(RunTarget::parse)
                    if (id != null && parts != null) {
                        val target = RunTarget(id, intent.getStringExtra(PinWidgetActivity.EXTRA_NAME) ?: "Job", parts.kind)
                        updateAppWidgetState(app, glanceId) {
                            it[RunWidget.TARGET] = OptioJson.encodeToString(RunTarget.serializer(), target)
                            it[RunWidget.CONFIRM] = intent.getBooleanExtra(PinWidgetActivity.EXTRA_CONFIRM, true)
                            it[RunWidget.TICK] = System.currentTimeMillis()
                        }
                    }
                    RunWidget().update(app, glanceId)
                } else {
                    intent.getStringExtra(PinWidgetActivity.EXTRA_SERVER)?.let { server ->
                        updateAppWidgetState(app, glanceId) {
                            it[WorkWidget.SERVER] = server
                            it[WorkWidget.TICK] = System.currentTimeMillis()
                        }
                    }
                    WorkWidget().update(app, glanceId)
                    WidgetRefreshWorker.enqueue(app)
                }
            } finally {
                pending.finish()
            }
        }
    }
}
