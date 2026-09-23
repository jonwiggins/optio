package dev.optio.feature.reviews

import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.FakeRequest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * [FakeOptioServer.awaitRequest] off the test thread: the ViewModel's coroutines are queued on the
 * test dispatcher and only run while the test body is suspended, so a blocking wait on the test
 * thread would starve them.
 */
internal suspend fun FakeOptioServer.nextRequest(method: String, path: String, timeoutMs: Long = 5_000): FakeRequest =
    withContext(Dispatchers.IO) { awaitRequest(method, path, timeoutMs) }
