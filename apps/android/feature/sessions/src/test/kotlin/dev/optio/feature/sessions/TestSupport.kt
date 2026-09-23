package dev.optio.feature.sessions

import dev.optio.core.network.ApiClient
import dev.optio.core.network.WebSocketClient
import java.util.concurrent.Executors
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.rules.TestWatcher
import org.junit.runner.Description

/**
 * `Dispatchers.Main` on one real thread, for ViewModels that talk to a real (fake) server over
 * OkHttp: virtual time can't wait for sockets. Tests read state with [eventually].
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

    /** Runs [block] on the main thread and returns its result. */
    fun <T> onMain(block: suspend () -> T): T = runBlocking { withContext(dispatcher) { block() } }
}

/** Polls [condition] (on the calling thread) until it holds or [timeoutMs] passes. */
fun eventually(timeoutMs: Long = 5_000, message: () -> String = { "condition" }, condition: () -> Boolean) {
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
