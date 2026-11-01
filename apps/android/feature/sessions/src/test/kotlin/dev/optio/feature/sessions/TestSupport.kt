package dev.optio.feature.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.optio.core.network.ApiClient
import dev.optio.core.network.WebSocketClient
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.rules.TestWatcher
import org.junit.runner.Description

/**
 * `Dispatchers.Main` on one real thread, for ViewModels that talk to a real (fake) server over
 * OkHttp: virtual time can't wait for sockets. Tests read state with [eventually]. Make
 * ViewModels with [viewModel], so they are cleared before `Dispatchers.Main` is reset.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RealMainRule : TestWatcher() {
    lateinit var dispatcher: ExecutorCoroutineDispatcher
        private set

    @PublishedApi internal val viewModels = ViewModelStore()

    @PublishedApi internal val viewModelJobs = CopyOnWriteArrayList<Job>()

    override fun starting(description: Description) {
        dispatcher = Executors.newSingleThreadExecutor { r -> Thread(r, "test-main").apply { isDaemon = true } }.asCoroutineDispatcher()
        Dispatchers.setMain(dispatcher)
    }

    override fun finished(description: Description) {
        try {
            // A ViewModel's coroutine still running after the test (a reply landing after the
            // last assertion) resumes through Dispatchers.Main, and doing that while the next test
            // sets it fails that test ("Dispatchers.Main is used concurrently with setting it").
            // Clear them, then wait until their coroutines are over.
            onMain { viewModels.clear() }
            runBlocking { withTimeout(10.seconds) { viewModelJobs.joinAll() } }
        } finally {
            Dispatchers.resetMain()
            dispatcher.close()
        }
    }

    /** Makes a ViewModel on the main thread; it is cleared when the test ends. */
    inline fun <reified VM : ViewModel> viewModel(noinline create: () -> VM): VM =
        onMain {
            ViewModelProvider.create(viewModels, viewModelFactory { initializer { create() } })[UUID.randomUUID().toString(), VM::class]
                .also { viewModelJobs += it.viewModelScope.coroutineContext.job }
        }

    /** Runs [block] on the main thread and returns its result. */
    fun <T> onMain(block: suspend () -> T): T = runBlocking { withContext(dispatcher) { block() } }
}

/** Polls [condition] (on the calling thread) until it holds or [timeoutMs] passes. */
fun eventually(timeoutMs: Long = 10_000, message: () -> String = { "condition" }, condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
        if (condition()) return
        Thread.sleep(10)
    }
    if (!condition()) throw AssertionError("Timed out waiting for ${message()}")
}

/** A socket factory with a short reconnect delay and the PAT as the token (no ws-token round trip). */
fun fastSockets(reconnectMs: Long = 150): (ApiClient, String) -> WebSocketClient =
    { api, path ->
        WebSocketClient(
            url = api.wsUrl(path),
            tokenProvider = { api.token },
            httpClient = api.webSocketHttpClient,
            reconnectDelay = reconnectMs.milliseconds,
        )
    }
