package dev.optio.feature.more

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.viewModelFactory
import org.junit.rules.TestWatcher
import org.junit.runner.Description

/**
 * Owns the ViewModels a test creates and clears them when it ends, so a request still in flight
 * is cancelled with its `viewModelScope` instead of resuming on a reset Main dispatcher. Order it
 * inside [dev.optio.core.testing.MainDispatcherRule]: `@get:Rule(order = 1)`.
 */
class ViewModelsRule : TestWatcher() {
    private val store = ViewModelStore()
    private var next = 0

    fun <VM : ViewModel> add(
        type: Class<VM>,
        create: () -> VM,
    ): VM = ViewModelProvider.create(store, viewModelFactory { addInitializer(type.kotlin) { create() } })["vm-${next++}", type.kotlin]

    inline fun <reified VM : ViewModel> of(noinline create: () -> VM): VM = add(VM::class.java, create)

    override fun finished(description: Description) {
        store.clear()
    }
}
