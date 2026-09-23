package dev.optio.core.model

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import org.junit.Test

class RawEnumTest {
    @Test
    fun decodesKnownValuesAndFallsBackForUnknownOnes() {
        assertEquals(TaskState.PR_OPENED, OptioJson.decodeFromString(TaskState.serializer(), "\"pr_opened\""))
        assertEquals(TaskState.UNKNOWN, OptioJson.decodeFromString(TaskState.serializer(), "\"teleported\""))
        assertEquals(
            listOf(GitHubEventKind.PR_OPENED, GitHubEventKind.UNKNOWN, GitHubEventKind.MENTIONED),
            OptioJson.decodeFromString<List<GitHubEventKind>>("""["pr_opened","discussion_started","mentioned"]"""),
        )
    }

    @Test
    fun encodesTheWireValue() {
        assertEquals("\"claude-code\"", OptioJson.encodeToString(LocalAgentKind.serializer(), LocalAgentKind.CLAUDE_CODE))
        assertEquals("\"waits-for-me\"", OptioJson.encodeToString(WatchThen.serializer(), WatchThen.WAITS_FOR_ME))
        assertEquals("claude-code", LocalAgentKind.CLAUDE_CODE.raw)
        // Like iOS, re-encoding the fallback writes the sentinel, never the lost value.
        assertEquals("\"__unknown__\"", OptioJson.encodeToString(TaskState.serializer(), TaskState.UNKNOWN))
    }

    @Test
    fun companionHelpersMirrorSwift() {
        assertEquals(10, TaskState.allCases.size)
        assertFalse(TaskState.UNKNOWN in TaskState.allCases)
        assertEquals(TaskState.entries.size - 1, TaskState.allCases.size)
        assertEquals(TaskState.QUEUED, TaskState.fromRaw("queued"))
        assertEquals(TaskState.UNKNOWN, TaskState.fromRaw("nope"))
        assertEquals(TaskState.WAITING_ON_DEPS, TaskState.fromRawOrNull("waiting_on_deps"))
        assertNull(TaskState.fromRawOrNull("nope"))
    }

    @Test
    fun aRealUnknownValueKeepsItsOwnEntry() {
        // `ConnectionStatus` has a genuine "unknown"; the fallback keeps the UNKNOWN name.
        assertEquals(ConnectionStatus.UNKNOWN_VALUE, ConnectionStatus.fromRaw("unknown"))
        assertEquals(ConnectionStatus.UNKNOWN, ConnectionStatus.fromRaw("degraded"))
        assertEquals("unknown", ConnectionStatus.UNKNOWN_VALUE.raw)
        assertEquals(ContainerStatus.State.UNKNOWN_VALUE, ContainerStatus.State.fromRaw("unknown"))
    }

    @Test
    fun nestedAndDerivedEnums() {
        assertEquals(CICheck.Conclusion.SUCCESS, CICheck.Conclusion.fromRaw("success"))
        assertEquals(Review.State.CHANGES_REQUESTED, Review.State.fromRaw("CHANGES_REQUESTED"))
        assertEquals(ContainerSpec.ImagePullPolicy.IF_NOT_PRESENT, ContainerSpec.ImagePullPolicy.fromRaw("IfNotPresent"))
        // `keyof typeof PRESET_IMAGES`, sorted like gen-swift.
        assertEquals(
            listOf("base", "dart", "dind", "full", "go", "node", "python", "ruby", "rust"),
            PresetImageId.allCases.map { it.raw },
        )
        assertEquals(PersistentAgentPodLifecycle.ALWAYS_ON, PersistentAgentPodLifecycle.fromRaw("always-on"))
    }
}
