package dev.optio.feature.widgets.config

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.datastore.preferences.core.Preferences
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.getAppWidgetState
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.lifecycle.lifecycleScope
import dev.optio.core.data.ServerProfile
import dev.optio.core.model.OptioJson
import dev.optio.core.ui.theme.AppearanceStore
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.collectAppearance
import dev.optio.feature.widgets.Links
import dev.optio.feature.widgets.OptioWidgets
import dev.optio.feature.widgets.refresh.WidgetRefreshWorker
import dev.optio.feature.widgets.run.RunTarget
import dev.optio.feature.widgets.run.RunWidget
import dev.optio.feature.widgets.shortcuts.AppShortcuts
import dev.optio.feature.widgets.work.WorkWidget
import kotlinx.coroutines.launch

/** Compose in the app's theme and appearance choice (system / light / dark). */
internal fun ComponentActivity.setThemedContent(content: @Composable () -> Unit) {
    val appearance = AppearanceStore.create(this)
    setContent { OptioTheme(appearance.collectAppearance()) { content() } }
}

/**
 * Sets a widget up when it is placed, and again from the launcher's "Reconfigure": the Work
 * widget's Server option (iOS `GlanceConfigurationIntent`), one paired server or all of them.
 * Placing it without configuring shows every server.
 */
class WorkWidgetConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val appWidgetId = intent?.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        val result = Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
        setResult(Activity.RESULT_CANCELED, result)
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }
        val glanceId = GlanceAppWidgetManager(this).getGlanceIdBy(appWidgetId)
        setThemedContent {
            val servers by produceState<List<ServerProfile>?>(null) { value = OptioWidgets.session()?.registry?.configured().orEmpty() }
            val saved by produceState<Preferences?>(null) { value = getAppWidgetState(this@WorkWidgetConfigActivity, PreferencesGlanceStateDefinition, glanceId) }
            var choice by rememberSaveable { mutableStateOf<String?>(null) }
            var touched by rememberSaveable { mutableStateOf(false) }
            val selection = if (touched) choice else saved?.get(WorkWidget.SERVER)
            ConfigScreen(
                title = "Work widget",
                onClose = ::finish,
                primaryLabel = "Save",
                primaryEnabled = servers != null,
                onPrimary = {
                    lifecycleScope.launch {
                        updateAppWidgetState(this@WorkWidgetConfigActivity, glanceId) { prefs ->
                            if (selection == null) prefs.remove(WorkWidget.SERVER) else prefs[WorkWidget.SERVER] = selection
                            prefs[WorkWidget.TICK] = System.currentTimeMillis()
                        }
                        WorkWidget().update(this@WorkWidgetConfigActivity, glanceId)
                        WidgetRefreshWorker.enqueue(this@WorkWidgetConfigActivity)
                        setResult(Activity.RESULT_OK, result)
                        finish()
                    }
                },
            ) {
                val paired = servers ?: return@ConfigScreen
                if (paired.isEmpty()) {
                    signedOut { startActivity(Links.launch(this@WorkWidgetConfigActivity)) }
                } else {
                    serverChoices(paired, selection) {
                        choice = it
                        touched = true
                    }
                }
            }
        }
    }
}

/**
 * Sets a Run widget up (iOS `RunConfigurationIntent`): the target, "Ask before running", and a
 * home-screen shortcut for the target. Also opens from an unconfigured widget's tap, because a
 * widget pinned from inside an app skips the launcher's setup step.
 */
class RunWidgetConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val appWidgetId = intent?.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        val result = Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
        setResult(Activity.RESULT_CANCELED, result)
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }
        val glanceId = GlanceAppWidgetManager(this).getGlanceIdBy(appWidgetId)
        setThemedContent {
            val saved by produceState<Pair<RunTarget?, Boolean>?>(null) { value = RunWidget.config(this@RunWidgetConfigActivity, glanceId) }
            val current = saved ?: return@setThemedContent
            RunTargetConfig(
                title = "Run widget",
                initial = current.first,
                confirm = current.second,
                onClose = ::finish,
                onSave = { target, confirm ->
                    lifecycleScope.launch {
                        updateAppWidgetState(this@RunWidgetConfigActivity, glanceId) { prefs ->
                            prefs[RunWidget.TARGET] = OptioJson.encodeToString(RunTarget.serializer(), target)
                            prefs[RunWidget.CONFIRM] = confirm
                            prefs[RunWidget.TICK] = System.currentTimeMillis()
                        }
                        RunWidget().update(this@RunWidgetConfigActivity, glanceId)
                        setResult(Activity.RESULT_OK, result)
                        finish()
                    }
                },
                onOpenApp = { startActivity(Links.launch(this@RunWidgetConfigActivity)) },
                onPin = { target ->
                    if (!AppShortcuts.requestPin(this@RunWidgetConfigActivity, target)) {
                        Toast.makeText(this@RunWidgetConfigActivity, "This launcher can't add shortcuts.", Toast.LENGTH_SHORT).show()
                    }
                },
            )
        }
    }
}
