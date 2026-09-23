package dev.optio.core.ui.theme

import android.content.Context
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Contrast
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.LightMode
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

/**
 * User-selectable colour scheme (iOS `AppAppearance`). [SYSTEM], the default, follows the device.
 * Persisted by [AppearanceStore] under [STORAGE_KEY] with the [raw] value.
 */
enum class AppAppearance(val raw: String, val label: String) {
    SYSTEM("system", "System"),
    LIGHT("light", "Light"),
    DARK("dark", "Dark"),
    ;

    /** The Material Symbol for pickers (iOS `circle.lefthalf.filled` / `sun.max` / `moon`). */
    val icon: ImageVector
        get() = when (this) {
            SYSTEM -> Icons.Outlined.Contrast
            LIGHT -> Icons.Outlined.LightMode
            DARK -> Icons.Outlined.DarkMode
        }

    /** Whether this appearance renders dark right now. */
    @Composable
    @ReadOnlyComposable
    fun isDark(): Boolean = when (this) {
        SYSTEM -> isSystemInDarkTheme()
        LIGHT -> false
        DARK -> true
    }

    companion object {
        const val STORAGE_KEY = "optio.appearance"

        /** The appearance for a stored raw value; unknown or missing → [SYSTEM]. */
        fun fromRaw(raw: String?): AppAppearance = entries.firstOrNull { it.raw == raw } ?: SYSTEM
    }
}

private val Context.appearanceDataStore: DataStore<Preferences> by preferencesDataStore(name = "optio_appearance")

/**
 * Persists the [AppAppearance] choice in a small Preferences DataStore. The app creates one per
 * process (`AppearanceStore.create(context)` in `Application.onCreate`, so the stored value is read
 * before the first frame), feeds [appearance] into [OptioTheme], and provides the store through
 * [LocalAppearanceStore] so Settings can change it.
 */
class AppearanceStore(
    private val dataStore: DataStore<Preferences>,
    scope: CoroutineScope,
) {
    /** The current choice; [AppAppearance.SYSTEM] until the file has been read. */
    val appearance: StateFlow<AppAppearance> = dataStore.data
        .catch { error -> if (error is IOException) emit(androidx.datastore.preferences.core.emptyPreferences()) else throw error }
        .map { AppAppearance.fromRaw(it[KEY]) }
        .stateIn(scope, SharingStarted.Eagerly, AppAppearance.SYSTEM)

    suspend fun set(appearance: AppAppearance) {
        dataStore.edit { it[KEY] = appearance.raw }
    }

    companion object {
        private val KEY = stringPreferencesKey(AppAppearance.STORAGE_KEY)

        /** The process-wide store backed by the `optio_appearance` DataStore file. */
        fun create(
            context: Context,
            scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
        ): AppearanceStore = AppearanceStore(context.applicationContext.appearanceDataStore, scope)
    }
}

/** The app's [AppearanceStore]; null in previews and tests (read-only appearance). */
val LocalAppearanceStore = staticCompositionLocalOf<AppearanceStore?> { null }

/** The stored appearance as Compose state ([AppAppearance.SYSTEM] when [store] is null). */
@Composable
fun AppearanceStore?.collectAppearance(): AppAppearance {
    if (this == null) return AppAppearance.SYSTEM
    val value by appearance.collectAsStateWithLifecycle()
    return value
}
