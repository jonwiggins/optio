package dev.optio.feature.widgets.shortcuts

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.optio.core.glance.RunTarget
import kotlin.test.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

/**
 * Recent run shortcuts survive an app-icon switch: Android deletes dynamic shortcuts attached to a
 * launcher alias when the icon picker disables it (QA: the Run widget's shortcut vanished after
 * switching to Midnight), so [AppShortcuts] remembers them and [AppShortcuts.restore] puts them back.
 */
@RunWith(AndroidJUnit4::class)
class AppShortcutsTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val launcher = ComponentName(context.packageName, "dev.optio.app.LauncherMidnight")

    private fun target(n: Int) = RunTarget("dev-server|job:job-$n", "Job $n", RunTarget.Kind.JOB)

    private fun dynamicIds() = ShortcutManagerCompat.getDynamicShortcuts(context).map { it.id }.toSet()

    @Before
    fun launcherAlias() {
        // The app's enabled MAIN/LAUNCHER alias (this module's test APK has none of its own).
        val pm = shadowOf(context.packageManager)
        pm.addActivityIfNotPresent(launcher)
        pm.addIntentFilterForActivity(launcher, IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_LAUNCHER) })
        ShortcutManagerCompat.removeAllDynamicShortcuts(context)
    }

    @Test
    fun remembersTheMostRecentTargetsFirst() {
        (1..5).forEach { AppShortcuts.recordFired(context, target(it)) }
        AppShortcuts.recordFired(context, target(3)) // fired again: moves to the front, no duplicate

        assertEquals(listOf(3, 5, 4, 2).map { target(it) }, AppShortcuts.recent(context))
    }

    @Test
    fun restoresShortcutsTheSystemDeleted() {
        AppShortcuts.recordFired(context, target(1))
        AppShortcuts.recordFired(context, target(2))
        assertEquals(setOf(AppShortcuts.id(target(1)), AppShortcuts.id(target(2))), dynamicIds())

        // What the system does to shortcuts on the alias the icon picker just disabled.
        ShortcutManagerCompat.removeAllDynamicShortcuts(context)

        assertEquals(2, AppShortcuts.restore(context))
        assertEquals(setOf(AppShortcuts.id(target(1)), AppShortcuts.id(target(2))), dynamicIds())
        assertEquals(0, AppShortcuts.restore(context), "idempotent: nothing missing, nothing re-published")
    }
}
