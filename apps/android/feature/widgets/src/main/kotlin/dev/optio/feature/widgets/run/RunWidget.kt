package dev.optio.feature.widgets.run

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.unit.dp
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.action.ActionParameters
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.state.getAppWidgetState
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.width
import androidx.glance.semantics.semantics
import androidx.glance.semantics.testTag
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import dev.optio.core.data.ServerColor
import dev.optio.core.model.OptioJson
import dev.optio.feature.widgets.OptioWidgets
import dev.optio.feature.widgets.R
import dev.optio.feature.widgets.config.RunWidgetConfigActivity
import dev.optio.feature.widgets.data.WidgetStore
import dev.optio.feature.widgets.model.GlancePolicy
import dev.optio.feature.widgets.ui.Dot
import dev.optio.feature.widgets.ui.Glyph
import dev.optio.feature.widgets.ui.WidgetColors
import dev.optio.feature.widgets.ui.WidgetType
import dev.optio.feature.widgets.ui.shortTime
import dev.optio.feature.widgets.work.SignedOutBody
import dev.optio.feature.widgets.work.WidgetSurface
import java.time.Instant
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map

/**
 * "Run": the phone as a remote control for one recurring item (iOS `RunWidget`, kind
 * `dev.optio.ios.run`): a Local blueprint (`POST /api/local/blueprints/:id/spawn`) or a Job
 * (`POST /api/jobs/:id/runs`) on any paired server. One configurable target, one tap. Modest by
 * design: no status, no history, just the name and "Started" for a minute after firing.
 */
class RunWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Single

    override suspend fun provideGlance(
        context: Context,
        id: GlanceId,
    ) {
        val store = WidgetStore.get(context)
        val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        val registry = OptioWidgets.session()?.registry
        val servers = registry?.let { combine(it.profiles, it.activeIdChanges) { _, _ -> }.map { _ -> it.configured() } } ?: flowOf(emptyList())
        val initialServers = registry?.configured().orEmpty()
        val initialPrefs = store.snapshot()
        provideContent {
            val state = currentState<Preferences>()
            val paired by servers.collectAsState(initialServers)
            val prefs by store.data.collectAsState(initialPrefs)
            val target = targetOf(state)
            val server = target?.serverId?.let { id -> paired.firstOrNull { it.id == id } }
            RunWidgetContent(
                RunWidgetState(
                    signedIn = paired.isNotEmpty(),
                    target = target,
                    confirm = state[CONFIRM] ?: true,
                    startedAt = target?.let { WidgetStore.startedAt(prefs, it.id) },
                    armedAt = target?.let { WidgetStore.armedAt(prefs, it.id) },
                    now = Instant.now(),
                    serverName = if (paired.size > 1) target?.serverName ?: server?.shortName else null,
                    serverColor = if (paired.size > 1) server?.color else null,
                    appWidgetId = appWidgetId,
                ),
            )
        }
    }

    override suspend fun providePreview(
        context: Context,
        widgetCategory: Int,
    ) {
        provideContent { RunWidgetContent(RunWidgetState.sample(Instant.now())) }
    }

    companion object {
        /** The configured target (JSON [RunTarget]). */
        val TARGET = stringPreferencesKey("run.target")

        /** "Ask before running" (two taps); default on, like iOS. */
        val CONFIRM = booleanPreferencesKey("run.confirm")

        /** Bumped by every refresh so a running session recomposes and re-reads the clock. */
        val TICK = longPreferencesKey("run.tick")

        fun targetOf(state: Preferences): RunTarget? =
            state[TARGET]?.let { runCatching { OptioJson.decodeFromString(RunTarget.serializer(), it) }.getOrNull() }

        /** A placed Run widget's configuration, read outside its composition. */
        suspend fun config(
            context: Context,
            id: GlanceId,
        ): Pair<RunTarget?, Boolean> {
            val state = getAppWidgetState(context, PreferencesGlanceStateDefinition, id)
            return targetOf(state) to (state[CONFIRM] ?: true)
        }
    }
}

/** Receives the Run widget's broadcasts. */
class RunWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = RunWidget()
}

/** Everything the Run widget shows. */
data class RunWidgetState(
    val signedIn: Boolean,
    val target: RunTarget?,
    val confirm: Boolean,
    val startedAt: Instant?,
    val armedAt: Instant?,
    val now: Instant,
    /** The target's server, shown when several servers are paired. */
    val serverName: String? = null,
    val serverColor: ServerColor? = null,
    val appWidgetId: Int = AppWidgetManager.INVALID_APPWIDGET_ID,
) {
    val showsStarted: Boolean
        get() = GlancePolicy.showsStarted(startedAt, now)

    val isArmed: Boolean
        get() = GlancePolicy.isArmed(armedAt, now)

    companion object {
        fun sample(now: Instant) =
            RunWidgetState(
                signedIn = true,
                target = RunTarget("srv-laptop|job:nightly", "Nightly release notes", RunTarget.Kind.JOB),
                confirm = true,
                startedAt = null,
                armedAt = null,
                now = now,
            )
    }
}

/** The Run widget's one layout (iOS `RunView`). */
@Composable
fun RunWidgetContent(state: RunWidgetState) {
    val context = LocalContext.current
    WidgetSurface {
        val target = state.target
        when {
            !state.signedIn -> SignedOutBody()
            target == null -> {
                val configure =
                    Intent(context, RunWidgetConfigActivity::class.java)
                        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, state.appWidgetId)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                Column(modifier = GlanceModifier.fillMaxSize().clickable(actionStartActivity(configure))) {
                    Glyph(R.drawable.widget_ic_play_circle, WidgetColors.secondary, 22.dp)
                    Spacer(GlanceModifier.defaultWeight())
                    Text("Run", style = WidgetType.style(WidgetType.headline, WidgetColors.secondary, FontWeight.Medium), maxLines = 1, modifier = GlanceModifier.semantics { testTag = "run-name" })
                    Text("Choose a blueprint or Job to start.", style = WidgetType.style(WidgetType.footnote, WidgetColors.tertiary), maxLines = 3)
                }
            }
            else -> {
                Column(modifier = GlanceModifier.fillMaxSize().clickable(actionRunCallback<RunTapAction>())) {
                    Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                        Glyph(
                            if (state.showsStarted) R.drawable.widget_ic_check_outline else R.drawable.widget_ic_play_circle,
                            if (state.showsStarted) WidgetColors.label else WidgetColors.secondary,
                            22.dp,
                        )
                        Spacer(GlanceModifier.defaultWeight())
                        Column(horizontalAlignment = Alignment.End) {
                            Text(target.kindWord, style = WidgetType.style(WidgetType.caption2, WidgetColors.tertiary), maxLines = 1)
                            state.serverName?.let { name ->
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    state.serverColor?.let {
                                        Dot(WidgetColors.server(it), size = 5.dp)
                                        Spacer(GlanceModifier.width(3.dp))
                                    }
                                    Text(name, style = WidgetType.style(WidgetType.caption2, WidgetColors.tertiary), maxLines = 1)
                                }
                            }
                        }
                    }
                    Spacer(GlanceModifier.defaultWeight())
                    Text(
                        target.name,
                        style = WidgetType.style(WidgetType.headline, WidgetColors.label, FontWeight.Medium),
                        maxLines = 2,
                        modifier = GlanceModifier.semantics { testTag = "run-name" },
                    )
                    Spacer(GlanceModifier.height(2.dp))
                    val (status, color, weight) =
                        when {
                            state.showsStarted && state.startedAt != null ->
                                Triple("Started · ${context.shortTime(state.startedAt)}", WidgetColors.secondary, FontWeight.Normal)
                            state.isArmed -> Triple("Tap again to run", WidgetColors.secondary, FontWeight.Medium)
                            else -> Triple(if (state.confirm) "Tap twice to run" else "Tap to run", WidgetColors.tertiary, FontWeight.Normal)
                        }
                    Text(status, style = WidgetType.style(WidgetType.footnote, color, weight), maxLines = 1, modifier = GlanceModifier.semantics { testTag = "run-status" })
                }
            }
        }
    }
}

/** A tap on a configured Run widget: arm or fire its target (in the background). */
class RunTapAction : ActionCallback {
    override suspend fun onAction(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters,
    ) {
        val (target, confirm) = RunWidget.config(context, glanceId)
        target ?: return
        RunFiring.toast(context, RunFiring.tap(context, target, confirm))
    }
}
