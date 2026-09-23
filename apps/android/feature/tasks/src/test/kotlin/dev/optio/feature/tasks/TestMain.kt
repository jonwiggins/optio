package dev.optio.feature.tasks

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.optio.core.network.ApiClient
import dev.optio.core.network.WebSocketClient
import java.util.concurrent.Executors
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import org.junit.rules.TestWatcher
import org.junit.runner.Description

/**
 * A real Main thread for tests that talk to [dev.optio.core.testing.FakeOptioServer]: one
 * single-thread dispatcher set as `Dispatchers.Main`, so ViewModels and log streams run exactly as
 * on Android (one thread, real I/O). Run test bodies with [onMain].
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RealMainRule : TestWatcher() {
    lateinit var dispatcher: ExecutorCoroutineDispatcher
        private set

    override fun starting(description: Description) {
        dispatcher = Executors.newSingleThreadExecutor { r -> Thread(r, "test-main").apply { isDaemon = true } }.asCoroutineDispatcher()
        Dispatchers.setMain(dispatcher)
    }

    override fun finished(description: Description) {
        Dispatchers.resetMain()
        dispatcher.close()
    }

    /** Runs [block] on the test Main thread, failing after [timeout]. Returns Unit (JUnit tests must be void). */
    fun onMain(timeout: Duration = 20.seconds, block: suspend CoroutineScope.() -> Unit) {
        runBlocking(dispatcher) { withTimeout(timeout) { block() } }
    }
}

/** Waits for a value matching [predicate]. */
suspend fun <T> StateFlow<T>.await(timeout: Duration = 10.seconds, predicate: (T) -> Boolean): T =
    withTimeout(timeout) { first(predicate) }

/** Polls [condition] until it holds. */
suspend fun eventually(timeout: Duration = 10.seconds, condition: () -> Boolean) {
    withTimeout(timeout) {
        while (!condition()) delay(20.milliseconds)
    }
}

/** A socket factory for [api] that reconnects fast (100 ms) and sends a fixed token. */
fun fastSockets(api: ApiClient): (String) -> WebSocketClient = { path ->
    WebSocketClient(url = api.wsUrl(path), tokenProvider = { "optio_pat_test" }, reconnectDelay = 100.milliseconds)
}

/** Creates a new [VM] in [this] store, under a fresh key (clear the store to run `onCleared`). */
inline fun <reified VM : ViewModel> ViewModelStore.make(noinline create: () -> VM): VM =
    ViewModelProvider.create(this, viewModelFactory { initializer { create() } })[java.util.UUID.randomUUID().toString(), VM::class]
