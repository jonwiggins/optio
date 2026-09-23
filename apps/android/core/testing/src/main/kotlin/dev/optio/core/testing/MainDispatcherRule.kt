package dev.optio.core.testing

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.rules.TestWatcher
import org.junit.runner.Description

/**
 * Swaps `Dispatchers.Main` for a [TestDispatcher] during each test, so ViewModels
 * (`viewModelScope`) and stores that default to Main run on virtual time. Share the scheduler with
 * `runTest(rule.dispatcher)` to drive both.
 *
 * ```
 * @get:Rule val main = MainDispatcherRule()
 * @Test fun loads() = runTest(main.dispatcher) { … advanceUntilIdle() … }
 * ```
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MainDispatcherRule(
    val dispatcher: TestDispatcher = StandardTestDispatcher(),
) : TestWatcher() {
    override fun starting(description: Description) {
        Dispatchers.setMain(dispatcher)
    }

    override fun finished(description: Description) {
        Dispatchers.resetMain()
    }
}
