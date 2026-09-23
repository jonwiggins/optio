package dev.optio.feature.widgets.shortcuts

import android.content.Context
import android.content.Intent
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import dev.optio.core.model.OptioJson
import dev.optio.feature.widgets.R
import dev.optio.core.glance.RunTarget

/**
 * Launcher shortcuts (the Android side of iOS App Shortcuts / Siri phrases):
 *
 * - static: **New work** and **Needs you** (`res/xml/optio_shortcuts.xml`, attached to the app's
 *   launcher activity by this module's manifest);
 * - dynamic: the run targets fired most recently from a widget, tile or shortcut ([recordFired]);
 * - pinned: a run target the user adds to the home screen from the Run widget's settings
 *   ([requestPin]).
 *
 * A run shortcut opens [RunShortcutActivity], which confirms and fires in the background.
 */
object AppShortcuts {
    const val ACTION_RUN = "dev.optio.widgets.action.RUN_TARGET"
    const val EXTRA_TARGET = "dev.optio.widgets.extra.TARGET"

    /** The shortcut id for [target] (stable, so firing it again updates the same shortcut). */
    fun id(target: RunTarget): String = "run:${target.id}"

    /** The shortcut for [target]. */
    fun info(
        context: Context,
        target: RunTarget,
    ): ShortcutInfoCompat =
        ShortcutInfoCompat.Builder(context, id(target))
            .setShortLabel(target.name)
            .setLongLabel("Run ${target.name}")
            .setIcon(IconCompat.createWithResource(context, R.drawable.shortcut_run))
            .setIntent(intent(context, target))
            .build()

    /** What a run shortcut launches (explicit: [RunShortcutActivity] is not exported). */
    fun intent(
        context: Context,
        target: RunTarget,
    ): Intent =
        Intent(ACTION_RUN)
            .setClass(context, RunShortcutActivity::class.java)
            .putExtra(EXTRA_TARGET, OptioJson.encodeToString(RunTarget.serializer(), target))

    /** The target a run shortcut carries. */
    fun target(intent: Intent?): RunTarget? =
        intent?.getStringExtra(EXTRA_TARGET)?.let { runCatching { OptioJson.decodeFromString(RunTarget.serializer(), it) }.getOrNull() }

    /** Offers [target] as a recent shortcut (the launcher keeps the few most recent). */
    fun recordFired(
        context: Context,
        target: RunTarget,
    ) {
        runCatching {
            ShortcutManagerCompat.pushDynamicShortcut(context, info(context, target))
            ShortcutManagerCompat.reportShortcutUsed(context, id(target))
        }
    }

    /** Asks the launcher to pin a shortcut for [target]; false when it can't. */
    fun requestPin(
        context: Context,
        target: RunTarget,
    ): Boolean =
        ShortcutManagerCompat.isRequestPinShortcutSupported(context) &&
            runCatching { ShortcutManagerCompat.requestPinShortcut(context, info(context, target), null) }.getOrDefault(false)
}
