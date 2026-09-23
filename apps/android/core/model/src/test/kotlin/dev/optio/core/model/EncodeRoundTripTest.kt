package dev.optio.core.model

import kotlin.test.assertEquals
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test

/** Request bodies and client → server frames: what the app sends. */
class EncodeRoundTripTest {
    @Test
    fun createTaskInputOmitsUnsetFieldsAndWritesWireValues() {
        val input = CreateTaskInput(
            title = "Fix flaky login test",
            prompt = "Find the race.",
            repoUrl = "https://github.com/acme/web",
            agentType = "claude-code",
            metadata = mapOf("source" to JsonPrimitive("android")),
            priority = 5.0,
            dependsOn = listOf("t0"),
            runTarget = RunTarget.LOCAL,
            localHostId = "h1",
            localDir = "/Users/dev/web",
            localSessionMode = LocalAgentSessionMode.INTERACTIVE,
        )
        val json = OptioJson.encodeToString(CreateTaskInput.serializer(), input)
        assertEquals(
            """{"title":"Fix flaky login test","prompt":"Find the race.","repoUrl":"https://github.com/acme/web",""" +
                """"agentType":"claude-code","metadata":{"source":"android"},"priority":5.0,"dependsOn":["t0"],""" +
                """"runTarget":"local","localHostId":"h1","localDir":"/Users/dev/web","localSessionMode":"interactive"}""",
            json,
        )
        assertEquals(input, OptioJson.decodeFromString(CreateTaskInput.serializer(), json))
    }

    @Test
    fun nestedInlineObjectsRoundTrip() {
        val input = CreateConnectionInput(
            name = "Linear",
            providerSlug = "linear",
            config = mapOf("team" to JsonPrimitive("ENG")),
            assignments = listOf(
                CreateConnectionInput.Assignment(agentTypes = listOf("claude-code"), permission = "read"),
            ),
        )
        val json = OptioJson.encodeToString(CreateConnectionInput.serializer(), input)
        assertEquals(
            """{"name":"Linear","providerSlug":"linear","config":{"team":"ENG"},""" +
                """"assignments":[{"agentTypes":["claude-code"],"permission":"read"}]}""",
            json,
        )
        assertEquals(input, OptioJson.decodeFromString(CreateConnectionInput.serializer(), json))
    }

    @Test
    fun terminalStreamFramesCarryTheirDiscriminator() {
        val input: LocalStreamClientMessage = LocalStreamClientMessage.Input(data = "ls -la\r")
        val resize: LocalStreamClientMessage = LocalStreamClientMessage.Resize(cols = 120.0, rows = 32.0)
        assertEquals(
            """{"type":"input","data":"ls -la\r"}""",
            OptioJson.encodeToString(LocalStreamClientMessage.serializer(), input),
        )
        assertEquals(
            """{"type":"resize","cols":120.0,"rows":32.0}""",
            OptioJson.encodeToString(LocalStreamClientMessage.serializer(), resize),
        )
        for (frame in listOf(input, resize)) {
            val json = OptioJson.encodeToString(LocalStreamClientMessage.serializer(), frame)
            assertEquals(frame, OptioJson.decodeFromString(LocalStreamClientMessage.serializer(), json))
        }
    }

    @Test
    fun sessionChatFramesRoundTrip() {
        val frames = listOf(
            SessionChatClientMessage.Message(content = "run the tests") to """{"type":"message","content":"run the tests"}""",
            SessionChatClientMessage.Interrupt to """{"type":"interrupt"}""",
            SessionChatClientMessage.SetModel(model = "opus") to """{"type":"set_model","model":"opus"}""",
        )
        for ((frame, expected) in frames) {
            assertEquals(expected, OptioJson.encodeToString(SessionChatClientMessage.serializer(), frame))
            assertEquals(frame, OptioJson.decodeFromString(SessionChatClientMessage.serializer(), expected))
        }
    }
}
