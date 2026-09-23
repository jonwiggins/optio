package dev.optio.feature.widgets.shortcuts

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.core.content.edit
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import dev.optio.core.glance.RunTarget
import dev.optio.core.model.OptioJson
import dev.optio.feature.widgets.R
import kotlinx.serialization.builtins.ListSerializer

/**
 * Launcher shortcuts (the Android side of iOS App Shortcuts / Siri phrases):
 *
 * - static: **New work** and **Needs you** (`res/xml/optio_shortcuts.xml`, attached to the app's
 *   launcher activity by this module's manifest);
 * - dynamic: the run targets fired most recently from a widget, tile or shortcut ([recordFired]).
 *   Android deletes a dynamic shortcut when the launcher activity it is attached to is disabled,
 *   which is what switching the app icon does (one `activity-alias` for another), so the targets
 *   are also remembered here and [restore] re-publishes them on the enabled alias;
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

    /** The shortcut for [target], attached to [activity] (a launcher alias; null = the system's pick). */
    fun info(
        context: Context,
        target: RunTarget,
        activity: ComponentName? = null,
    ): ShortcutInfoCompat =
        ShortcutInfoCompat.Builder(context, id(target))
            .setShortLabel(target.name)
            .setLongLabel("Run ${target.name}")
            .setIcon(IconCompat.createWithResource(context, R.drawable.shortcut_run))
            .setIntent(intent(context, target))
            .apply { if (activity != null) setActivity(activity) }
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
        remember(context, target)
        runCatching {
            ShortcutManagerCompat.pushDynamicShortcut(context, info(context, target))
            ShortcutManagerCompat.reportShortcutUsed(context, id(target))
        }
    }

    /** The run targets [recordFired] offered, most recent first (at most [MAX_RECENT]). */
    fun recent(context: Context): List<RunTarget> =
        prefs(context).getString(KEY_RECENT, null)
            ?.let { runCatching { OptioJson.decodeFromString(recentSerializer, it) }.getOrNull() }
            .orEmpty()

    /**
     * Re-publishes the [recent] run shortcuts the launcher lost or keeps on a launcher alias that is
     * no longer enabled (switching the app icon disables the old alias, and Android deletes the
     * dynamic shortcuts attached to it). Idempotent; returns how many it published.
     */
    fun restore(context: Context): Int {
        val recent = recent(context)
        if (recent.isEmpty()) return 0
        val launcher = launcherActivity(context) ?: return 0
        val published =
            runCatching { ShortcutManagerCompat.getDynamicShortcuts(context) }.getOrDefault(emptyList()).associateBy { it.id }
        var count = 0
        // Oldest first, so the most recent is published last, as recordFired left them.
        for (target in recent.asReversed()) {
            val current = published[id(target)]
            if (current != null && (current.activity == null || current.activity == launcher)) continue
            if (runCatching { ShortcutManagerCompat.pushDynamicShortcut(context, info(context, target, launcher)) }.isSuccess) count++
        }
        return count
    }

    /** The app's enabled launcher entry (the alias of the current app icon), if any. */
    internal fun launcherActivity(context: Context): ComponentName? {
        val main = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(context.packageName)
        return runCatching { context.packageManager.queryIntentActivities(main, 0) }.getOrNull()
            ?.firstOrNull()
            ?.activityInfo
            ?.let { ComponentName(it.packageName, it.name) }
    }

    private fun remember(
        context: Context,
        target: RunTarget,
    ) {
        val list = (listOf(target) + recent(context).filter { it.id != target.id }).take(MAX_RECENT)
        prefs(context).edit { putString(KEY_RECENT, OptioJson.encodeToString(recentSerializer, list)) }
    }

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** How many recent run shortcuts are kept (launchers show about four). */
    const val MAX_RECENT = 4
    private const val PREFS = "optio_run_shortcuts"
    private const val KEY_RECENT = "recent"
    private val recentSerializer = ListSerializer(RunTarget.serializer())

    /** Asks the launcher to pin a shortcut for [target]; false when it can't. */
    fun requestPin(
        context: Context,
        target: RunTarget,
    ): Boolean =
        ShortcutManagerCompat.isRequestPinShortcutSupported(context) &&
            runCatching { ShortcutManagerCompat.requestPinShortcut(context, info(context, target), null) }.getOrDefault(false)
}
