package dev.optio.core.workfeed

import dev.optio.core.network.ApiError
import dev.optio.core.testing.FakeOptioServer
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

/** The fan-out (iOS `sessionsFeedSources`): six endpoints in parallel, partial failure tolerated. */
class WorkFeedApiTest {
    private val server = FakeOptioServer().start()

    @AfterTest
    fun tearDown() = server.close()

    private fun serveAll() {
        server.json(WorkFeedEndpoints.UNIFIED, """{"tasks":[{"type":"repo-task","id":"t1","title":"Fix bug","state":"running"}],"limit":200,"offset":0,"total":1}""")
        server.json(WorkFeedEndpoints.LOCAL_TERMINALS, """{"terminals":[{"id":"lt1","title":"shell","state":"running","attentionState":"needs_you","spec":{"kind":"shell"}}]}""")
        server.json(WorkFeedEndpoints.LOCAL_BLUEPRINTS, """{"blueprints":[{"id":"a1","name":"Review PRs","enabled":true}]}""")
        server.json(WorkFeedEndpoints.POD_SESSIONS, """{"sessions":[{"id":"s1","state":"active","branch":"session/x"}],"activeCount":1}""")
        server.json(WorkFeedEndpoints.AGENTS, """{"agents":[{"id":"pa1","name":"Forge","state":"idle"}]}""")
        server.json(WorkFeedEndpoints.LOCAL_HOSTS, """{"hosts":[{"id":"h1","name":"M1","state":"online"}]}""")
    }

    @Test
    fun fetchesTheSixEndpointsWithTheWebsQueries() = runBlocking {
        serveAll()
        val sources = server.client().workFeedSources()

        assertEquals(1, sources.unified.size)
        assertEquals(1, sources.localTerminals.size)
        assertEquals(1, sources.localBlueprints.size)
        assertEquals(1, sources.podSessions.size)
        assertEquals(1, sources.agents.size)
        assertEquals(1, sources.hosts.size)

        val unified = server.lastRequest("GET", WorkFeedEndpoints.UNIFIED)!!
        assertEquals("all", unified.queryParam("type"))
        assertEquals("200", unified.queryParam("limit"))
        assertEquals("100", server.lastRequest("GET", WorkFeedEndpoints.POD_SESSIONS)!!.queryParam("limit"))
        assertEquals("Bearer ${FakeOptioServer.TEST_TOKEN}", unified.header("Authorization"))
        assertEquals(6, server.requests.size)
    }

    @Test
    fun oneBrokenKindNeverBlanksTheFeed() = runBlocking {
        serveAll()
        server.error("GET", WorkFeedEndpoints.POD_SESSIONS, 500, "boom")
        server.json(WorkFeedEndpoints.AGENTS, """{"unexpected":true}""") // undecodable: counts as failed
        val rows = WorkFeed.collect(server.client().workFeedSources())
        assertEquals(listOf("terminal-lt1", "task-t1", "automation-a1"), rows.map { it.key })
    }

    @Test
    fun theUnifiedErrorSurfacesOnlyWhenEverySourceFails() = runBlocking {
        listOf(
            WorkFeedEndpoints.LOCAL_TERMINALS, WorkFeedEndpoints.LOCAL_BLUEPRINTS, WorkFeedEndpoints.POD_SESSIONS,
            WorkFeedEndpoints.AGENTS, WorkFeedEndpoints.LOCAL_HOSTS,
        ).forEach { server.error("GET", it, 503, "down") }
        server.error("GET", WorkFeedEndpoints.UNIFIED, 500, "Database unavailable")

        val error = assertFailsWith<ApiError> { server.client().workFeedSources() }
        assertEquals(500, error.status)
        assertEquals("Database unavailable", error.message)

        // One source answering is enough.
        server.json(WorkFeedEndpoints.LOCAL_HOSTS, """{"hosts":[]}""")
        assertTrue(server.client().workFeedSources().unified.isEmpty())
    }
}
