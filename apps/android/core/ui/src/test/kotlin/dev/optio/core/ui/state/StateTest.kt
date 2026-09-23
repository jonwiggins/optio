package dev.optio.core.ui.state

import dev.optio.core.network.ApiError
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.SerializationException

/** `ErrorText.humanize` (iOS copy) and `LoadState` transitions. */
class StateTest {
    @Test
    fun httpErrorsReadAsPlainLanguage() {
        assertEquals("Slow down — the server is rate limiting. Retrying in a moment.", ErrorText.humanize(ApiError(429, "Too Many Requests")))
        assertEquals("Your access token was rejected. Sign in again.", ErrorText.humanize(ApiError(401, "Unauthorized")))
        assertEquals("You don't have permission for this.", ErrorText.humanize(ApiError(403, "Forbidden")))
        assertEquals("That job no longer exists.", ErrorText.humanize(ApiError(404, "Not Found"), what = "jobs"))
        assertEquals("Not found.", ErrorText.humanize(ApiError(404, "Not Found")))
        assertEquals("Couldn't load jobs — the server hit an error.", ErrorText.humanize(ApiError(502, "Bad Gateway"), what = "jobs"))
        assertEquals("Something went wrong — the server hit an error.", ErrorText.humanize(ApiError(500, "boom")))
        assertEquals("Repo already exists", ErrorText.humanize(ApiError(409, "Repo already exists")))
        assertEquals("Couldn't load tasks", ErrorText.humanize(ApiError(422, ""), what = "tasks"))
    }

    @Test
    fun statusZeroIsTransportOrDecoding() {
        val decoding = ApiError(0, "Decoding TasksPage failed: Unexpected JSON token", body = "{}")
        assertEquals(
            "Couldn't load tasks — the server sent something this version of the app doesn't understand.",
            ErrorText.humanize(decoding, what = "tasks"),
        )
        assertEquals("Can't reach the server.", ErrorText.humanize(ApiError(0, "A server with the specified hostname could not be found.", cause = UnknownHostException("x"))))
        assertEquals("Can't reach the server.", ErrorText.humanize(ApiError(0, "Could not connect to the server.", cause = ConnectException("refused"))))
        assertEquals("The server took too long to respond.", ErrorText.humanize(ApiError(0, "The request timed out.", cause = SocketTimeoutException("timeout"))))
        assertEquals("Can't reach the server. Check your connection.", ErrorText.humanize(ApiError(0, "Could not connect to the server.")))
        assertEquals("No Optio server is configured.", ErrorText.humanize(ApiError(0, "No Optio server is configured.")))
    }

    @Test
    fun nonApiErrors() {
        assertEquals(
            "Something went wrong — the server sent something this version of the app doesn't understand.",
            ErrorText.humanize(SerializationException("bad")),
        )
        assertEquals("Can't reach the server.", ErrorText.humanize(UnknownHostException("nope")))
        assertEquals("The server took too long to respond.", ErrorText.humanize(SocketTimeoutException()))
        assertEquals("Can't reach the server. Check your connection.", ErrorText.humanize(IOException("reset")))
        assertEquals("custom", ErrorText.humanize(IllegalStateException("custom")))
        assertEquals("Couldn't load agents", ErrorText.humanize(IllegalStateException(), what = "agents"))
    }

    @Test
    fun roleHelpers() {
        assertTrue(ApiError(403, "Forbidden").isForbidden)
        assertFalse(ApiError(401, "Unauthorized").isForbidden)
        assertTrue(ErrorText.isUnauthorized(ApiError(401, "x")))
        assertFalse(ErrorText.isForbidden(null))
        assertFalse(IOException().isForbidden)
    }

    @Test
    fun loadStateKeepsTheLastValue() {
        val idle: LoadState<Int> = LoadState.Idle
        assertNull(idle.value)
        val first = idle.loading()
        assertIs<LoadState.Loading<Int>>(first)
        assertTrue(first.isLoading)
        assertFalse(first.isRefreshing)
        val loaded: LoadState<Int> = LoadState.Loaded(3)
        val refreshing = loaded.loading()
        assertEquals(3, refreshing.value)
        assertTrue(refreshing.isRefreshing)
        val failed = refreshing.failed(IOException("down"))
        assertIs<LoadState.Failed<Int>>(failed)
        assertEquals(3, failed.value)
        assertEquals("down", failed.errorOrNull?.message)
        assertFalse(failed.isLoading)
    }

    @Test
    fun loadRunsTheBlockThroughTheStates() = runTest {
        val flow = MutableStateFlow<LoadState<String>>(LoadState.Idle)
        val gate = CompletableDeferred<String>()
        val job = launch { flow.load { gate.await() } }
        runCurrent()
        assertEquals(LoadState.Loading(null), flow.value)
        gate.complete("a")
        job.join()
        assertEquals(LoadState.Loaded("a"), flow.value)

        assertNull(flow.load { throw IOException("offline") })
        assertEquals("a", flow.value.value)
        assertIs<LoadState.Failed<String>>(flow.value)

        // Cancellation restores what was there.
        val hang = launch { flow.load { CompletableDeferred<String>().await() } }
        runCurrent()
        assertTrue(flow.value.isRefreshing)
        hang.cancel()
        runCurrent()
        assertIs<LoadState.Failed<String>>(flow.value)
    }
}
