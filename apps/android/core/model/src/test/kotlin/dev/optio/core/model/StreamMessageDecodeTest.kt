package dev.optio.core.model

import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test

/** Server → client frames on `/ws/local/terminals/:id/stream` and the session chat socket. */
class StreamMessageDecodeTest {
    private fun local(json: String) = OptioJson.decodeFromString(LocalStreamServerMessage.serializer(), json)

    private fun chat(json: String) = OptioJson.decodeFromString(SessionChatServerMessage.serializer(), json)

    @Test
    fun decodesTerminalStreamControlFrames() {
        assertEquals(
            LocalStreamServerMessage.Status(LocalTerminalState.RUNNING, LocalAttentionState.NEEDS_YOU),
            local("""{"type":"status","state":"running","attentionState":"needs_you"}"""),
        )
        assertEquals(LocalStreamServerMessage.Size(cols = 120.0, rows = 32.0), local("""{"type":"size","cols":120,"rows":32}"""))
        assertEquals(LocalStreamServerMessage.Exit(exitCode = null), local("""{"type":"exit","exitCode":null}"""))
        assertEquals(LocalStreamServerMessage.Exit(exitCode = 130.0), local("""{"type":"exit","exitCode":130}"""))
        assertEquals(LocalStreamServerMessage.Error("host went away"), local("""{"type":"error","message":"host went away"}"""))
        val replay = assertIs<LocalStreamServerMessage.Unknown>(local("""{"type":"replay-start","bytes":4096}"""))
        assertEquals(
            """{"type":"replay-start","bytes":4096}""",
            OptioJson.encodeToString(LocalStreamServerMessage.serializer(), replay),
        )
    }

    @Test
    fun decodesSessionChatFrames() {
        val event = assertIs<SessionChatServerMessage.ChatEvent>(
            chat(
                """{"type":"chat_event","event":{"taskId":"s1","timestamp":"2026-09-22T16:00:00.000Z",
                   "type":"tool_use","content":"Bash","metadata":{"toolName":"Bash","toolInput":{"command":"ls"},"extra":true}}}""",
            ),
        ).event
        assertEquals(SessionChatEvent.TypeValue.TOOL_USE, event.type)
        assertEquals(JsonPrimitive(true), event.metadata?.get("extra"))
        assertNull(event.sessionId)

        assertEquals(SessionChatServerMessage.CostUpdate(0.25), chat("""{"type":"cost_update","costUsd":0.25}"""))
        val status = assertIs<SessionChatServerMessage.Status>(chat("""{"type":"status","status":"thinking","model":"opus"}"""))
        assertEquals(SessionChatStatus.THINKING, status.status)
        assertEquals("opus", status.model)
        assertNull(status.costUsd)
        assertIs<SessionChatServerMessage.Unknown>(chat("""{"type":"typing"}"""))
    }

    @Test
    fun decodesDaemonFramesWithNestedModels() {
        val hello = assertIs<LocalDaemonMessage.Hello>(
            OptioJson.decodeFromString(
                LocalDaemonMessage.serializer(),
                """{"type":"hello","hostId":"h1","daemonVersion":"0.6.3","dirs":[{"path":"/tmp"}],
                   "terminals":[{"terminalId":"t1","running":true}]}""",
            ),
        )
        assertEquals(listOf(LocalDaemonTerminalSync("t1", true)), hello.terminals)
        assertNull(hello.claudeCredentials)
        val transcript = assertIs<LocalDaemonMessage.Transcript>(
            OptioJson.decodeFromString(
                LocalDaemonMessage.serializer(),
                """{"type":"transcript","terminalId":"t1","entries":[{"seq":1,"role":"assistant","kind":"tool_use",
                   "text":"Bash ls","detail":"{\"command\":\"ls\"}","toolName":"Bash","toolUseId":"tu1","isError":false,"at":null}]}""",
            ),
        )
        assertEquals(LocalTranscriptKind.TOOL_USE, transcript.entries.single().kind)
        assertEquals(LocalDaemonMessage.Ping, OptioJson.decodeFromString(LocalDaemonMessage.serializer(), """{"type":"ping"}"""))
    }
}
