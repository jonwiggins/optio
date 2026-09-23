package dev.optio.feature.more

import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.optio.feature.more.settings.AppIconOption
import dev.optio.feature.more.settings.AppIcons
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Launcher icon switching through the aliases' enabled states (the aliases themselves live in
 * `:app`'s manifest; Robolectric's package manager records the states for any component).
 */
@RunWith(AndroidJUnit4::class)
class AppIconsTest {
    private val context = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val pm = context.packageManager

    private fun state(option: AppIconOption) = pm.getComponentEnabledSetting(AppIcons.component(context.packageName, option))

    @Test
    fun theDefaultIconIsCurrentUntilOneIsPicked() {
        assertEquals(AppIconOption.DEFAULT, AppIcons.current(context))
    }

    @Test
    fun pickingAnIconEnablesItsAliasAndDisablesTheRest() {
        assertTrue(AppIcons.select(context, AppIconOption.MIDNIGHT))
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_ENABLED, state(AppIconOption.MIDNIGHT))
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DISABLED, state(AppIconOption.DEFAULT), "the manifest-enabled default goes off")
        assertEquals(AppIconOption.MIDNIGHT, AppIcons.current(context))
        // Aliases never touched stay at their (disabled) manifest default: nothing to write.
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DEFAULT, state(AppIconOption.CHIP))

        assertTrue(AppIcons.select(context, AppIconOption.RETRO))
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DISABLED, state(AppIconOption.MIDNIGHT))
        assertEquals(AppIconOption.RETRO, AppIcons.current(context))

        assertTrue(AppIcons.select(context, AppIconOption.DEFAULT))
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_ENABLED, state(AppIconOption.DEFAULT))
        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DISABLED, state(AppIconOption.RETRO))
        assertEquals(AppIconOption.DEFAULT, AppIcons.current(context))
    }

    @Test
    fun exactlyOneAliasIsEnabledAfterEverySwitch() {
        AppIconOption.entries.forEach { option ->
            AppIcons.select(context, option)
            val enabled = AppIconOption.entries.filter {
                when (state(it)) {
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
                    PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> it.enabledByDefault
                    else -> false
                }
            }
            assertEquals(listOf(option), enabled, "after picking ${option.title}")
        }
    }
}
