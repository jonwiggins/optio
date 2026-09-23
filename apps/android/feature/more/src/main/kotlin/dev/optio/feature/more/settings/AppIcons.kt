package dev.optio.feature.more.settings

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import androidx.annotation.DrawableRes
import dev.optio.feature.more.R

/**
 * One selectable launcher icon (iOS `AppIconOption`). Android has no `setAlternateIconName`: each
 * icon is an `<activity-alias>` of `MainActivity` in `:app`'s manifest (`dev.optio.app.Launcher<Name>`),
 * all with the MAIN/LAUNCHER filter, only [DEFAULT] enabled by default. Switching enables one alias
 * and disables the rest ([AppIcons.select]). Keep [alias] names in sync with the manifest and the
 * slugs with `feature/more/scripts/render-app-icons.mjs`.
 */
enum class AppIconOption(
    val slug: String,
    val title: String,
    val story: String,
    @param:DrawableRes val preview: Int,
) {
    DEFAULT("default", "Optio", "The original. White bot on Optio purple.", R.drawable.app_icon_default),
    MIDNIGHT("midnight", "Midnight", "Lights off, one eye still on. It's watching your PRs.", R.drawable.app_icon_midnight),
    TERMINAL("terminal", "Terminal", "The shell you left open. The bot is the prompt; the caret is you.", R.drawable.app_icon_terminal),
    BLUEPRINT("blueprint", "Blueprint", "Every robot starts as a drawing on blue paper.", R.drawable.app_icon_blueprint),
    STICKER("sticker", "Sticker", "Peeled off a laptop lid and slapped on slightly crooked.", R.drawable.app_icon_sticker),
    RETRO("retro", "Retro", "A 1983 monitor in a basement lab. Phosphor green and the hum.", R.drawable.app_icon_retro),
    SUNRISE("sunrise", "Sunrise", "It worked through the night. Morning, and the PR is up.", R.drawable.app_icon_sunrise),
    CHIP("chip", "Chip", "The silicon it runs on. One die, forty pins, the bot etched dead center.", R.drawable.app_icon_chip),
    ;

    /** The alias's class name in `:app`'s manifest (`dev.optio.app.LauncherMidnight`). */
    val alias: String
        get() = "$ALIAS_PREFIX${slug.replaceFirstChar { it.uppercaseChar() }}"

    /** Whether the manifest declares this alias enabled (only the default icon is). */
    val enabledByDefault: Boolean
        get() = this == DEFAULT

    companion object {
        const val ALIAS_PREFIX = "dev.optio.app.Launcher"

        fun fromSlug(slug: String?): AppIconOption? = entries.firstOrNull { it.slug == slug }
    }
}

/** Reads and switches the launcher icon through the aliases' enabled states. */
object AppIcons {
    /**
     * The icon the launcher shows now: the first enabled alias ([AppIconOption.DEFAULT] when none
     * reads as enabled, e.g. a build without the aliases).
     */
    fun current(context: Context): AppIconOption {
        val pm = context.packageManager
        return AppIconOption.entries.firstOrNull { isEnabled(pm, context.packageName, it) } ?: AppIconOption.DEFAULT
    }

    /**
     * Makes [option] the launcher icon: enables its alias first (so the app never has zero
     * launcher entries), then disables every other one. `DONT_KILL_APP` keeps this process
     * running. Returns false when the system refused (the alias is missing from this build).
     */
    fun select(
        context: Context,
        option: AppIconOption,
    ): Boolean {
        val pm = context.packageManager
        val pkg = context.packageName
        return try {
            pm.setComponentEnabledSetting(component(pkg, option), PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
            AppIconOption.entries.filter { it != option }.forEach { other ->
                if (isEnabled(pm, pkg, other)) {
                    pm.setComponentEnabledSetting(component(pkg, other), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
                }
            }
            true
        } catch (_: IllegalArgumentException) {
            false
        } catch (_: SecurityException) {
            false
        }
    }

    fun component(
        packageName: String,
        option: AppIconOption,
    ): ComponentName = ComponentName(packageName, option.alias)

    private fun isEnabled(
        pm: PackageManager,
        packageName: String,
        option: AppIconOption,
    ): Boolean {
        val state = try {
            pm.getComponentEnabledSetting(component(packageName, option))
        } catch (_: IllegalArgumentException) {
            return false // not in this build's manifest
        }
        return when (state) {
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
            PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> option.enabledByDefault
            else -> false
        }
    }
}
