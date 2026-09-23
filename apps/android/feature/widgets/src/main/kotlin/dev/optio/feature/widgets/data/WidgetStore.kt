package dev.optio.feature.widgets.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.optio.core.glance.RunTarget
import dev.optio.core.model.OptioJson
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first

/** One DataStore per process for what only this module keeps. */
private val Context.widgetsDataStore: DataStore<Preferences> by preferencesDataStore(name = "optio_widgets")

/**
 * What the widget module keeps for itself: the Run tile's target and a few flags. Everything the
 * surfaces share (per-server snapshots, "unreachable since", Later snoozes, the Run widget's
 * armed / started times) lives in `:core:glance`'s `GlanceStore`; a widget's own configuration
 * (its Server option, its Run target) lives in its Glance state.
 */
class WidgetStore(private val store: DataStore<Preferences>) {
    val data: Flow<Preferences>
        get() = store.data

    suspend fun snapshot(): Preferences = store.data.first()

    suspend fun setTileTarget(target: RunTarget?) {
        store.edit { if (target == null) it.remove(TILE_TARGET) else it[TILE_TARGET] = OptioJson.encodeToString(RunTarget.serializer(), target) }
    }

    suspend fun tileTarget(): RunTarget? = tileTarget(snapshot())

    /** A named on/off flag (e.g. "the Needs-you tile is in the panel"). */
    suspend fun setFlag(
        name: String,
        on: Boolean,
    ) {
        store.edit { if (on) it[flagKey(name)] = true else it.remove(flagKey(name)) }
    }

    suspend fun flag(name: String): Boolean = flag(snapshot(), name)

    companion object {
        private val TILE_TARGET = stringPreferencesKey("tile.run.target")

        private fun flagKey(name: String) = booleanPreferencesKey("flag.$name")

        @Volatile
        private var shared: WidgetStore? = null

        /** The process's store. */
        fun get(context: Context): WidgetStore =
            shared ?: synchronized(this) {
                shared ?: WidgetStore(context.applicationContext.widgetsDataStore).also { shared = it }
            }

        fun tileTarget(prefs: Preferences): RunTarget? =
            prefs[TILE_TARGET]?.let { runCatching { OptioJson.decodeFromString(RunTarget.serializer(), it) }.getOrNull() }

        fun flag(
            prefs: Preferences,
            name: String,
        ): Boolean = prefs[flagKey(name)] == true
    }
}
