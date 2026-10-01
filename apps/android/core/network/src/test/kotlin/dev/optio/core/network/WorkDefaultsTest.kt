package dev.optio.core.network

import dev.optio.core.model.OptioJson
import dev.optio.core.model.WorkFormDefaults
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer

class WorkDefaultsTest {
    private lateinit var server: MockWebServer
    private lateinit var api: ApiClient

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = ApiClient(baseUrl = server.url("/").toString(), token = "optio_pat_test")
    }

    @AfterTest
    fun tearDown() {
        server.close()
    }

    private fun enqueue(body: String) = server.enqueue(MockResponse.Builder().code(200).body(body).build())

    @Test
    fun getDecodesRuntimeAndPerRuntimeOptions() = runTest {
        enqueue(
            """{"defaults":{"runtime":"codex","agentOptions":{"codex":{"model":"gpt-5.5","reasoningEffort":"high","fastMode":true},"claude-code":{"claudeModel":"opus"}},"future":1}}""",
        )
        val d = api.getWorkDefaults()
        val req = checkNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        assertEquals("GET", req.method)
        assertEquals("/api/me/work-defaults", req.url.encodedPath)
        assertEquals("codex", d.runtime)
        assertEquals(JsonPrimitive("high"), d.agentOptions!!["codex"]!!["reasoningEffort"])
        assertEquals(JsonPrimitive(true), d.agentOptions!!["codex"]!!["fastMode"])
        assertEquals(JsonPrimitive("opus"), d.agentOptions!!["claude-code"]!!["claudeModel"])
    }

    @Test
    fun getWithNothingSavedIsEmpty() = runTest {
        enqueue("""{"defaults":{}}""")
        val d = api.getWorkDefaults()
        assertNull(d.runtime)
        assertNull(d.agentOptions)
    }

    @Test
    fun putSendsOneRuntimesOptionsAndDecodesTheMerge() = runTest {
        enqueue("""{"defaults":{"runtime":"claude-code","agentOptions":{"claude-code":{"claudeModel":"sonnet"},"codex":{"model":"gpt-5.5"}}}}""")
        val merged = api.putWorkDefaults(WorkFormDefaults(runtime = "claude-code", agentOptions = mapOf("claude-code" to mapOf("claudeModel" to JsonPrimitive("sonnet")))))
        val req = checkNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        assertEquals("PUT", req.method)
        assertEquals("/api/me/work-defaults", req.url.encodedPath)
        val body = OptioJson.parseToJsonElement(req.body!!.utf8()).jsonObject
        assertEquals(JsonPrimitive("claude-code"), body["runtime"])
        assertEquals(JsonPrimitive("sonnet"), body["agentOptions"]!!.jsonObject["claude-code"]!!.jsonObject["claudeModel"])
        assertEquals(setOf("claude-code", "codex"), merged.agentOptions!!.keys)
    }
}
