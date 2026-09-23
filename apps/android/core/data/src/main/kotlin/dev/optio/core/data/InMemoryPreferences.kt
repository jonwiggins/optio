package dev.optio.core.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * A `DataStore<Preferences>` held in memory, for tests and previews ([ServerRegistry.inMemory]).
 * Same semantics as the file-backed store: atomic, serialized updates and an observable [data].
 */
class InMemoryPreferences(initial: Preferences = emptyPreferences()) : DataStore<Preferences> {
    private val state = MutableStateFlow(initial)
    private val mutex = Mutex()

    override val data: Flow<Preferences> = state

    override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences =
        mutex.withLock {
            val updated = transform(state.value).let { if (it is MutablePreferences) it.toPreferences() else it }
            state.value = updated
            updated
        }
}
