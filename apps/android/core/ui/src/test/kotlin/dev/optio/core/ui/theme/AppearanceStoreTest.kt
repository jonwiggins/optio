package dev.optio.core.ui.theme

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Rule
import org.junit.rules.TemporaryFolder

/** The appearance choice persists and survives a new store on the same file. */
@OptIn(ExperimentalCoroutinesApi::class)
class AppearanceStoreTest {
    @get:Rule
    val folder = TemporaryFolder()

    @Test
    fun choicePersists() = runTest(UnconfinedTestDispatcher()) {
        val file = File(folder.root, "optio_appearance.preferences_pb")
        val dataStore = PreferenceDataStoreFactory.create(scope = backgroundScope) { file }
        val store = AppearanceStore(dataStore, backgroundScope)
        assertEquals(AppAppearance.SYSTEM, store.appearance.value)

        store.set(AppAppearance.DARK)
        assertEquals(AppAppearance.DARK, store.appearance.first { it == AppAppearance.DARK })
        store.set(AppAppearance.LIGHT)
        assertEquals(AppAppearance.LIGHT, store.appearance.first { it == AppAppearance.LIGHT })

        // What the file holds is the raw value iOS uses under `optio.appearance`.
        assertEquals("light", dataStore.data.first()[androidx.datastore.preferences.core.stringPreferencesKey(AppAppearance.STORAGE_KEY)])
    }
}
