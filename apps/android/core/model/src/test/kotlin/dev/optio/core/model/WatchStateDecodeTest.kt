package dev.optio.core.model

import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import org.junit.Test

/** `GET /api/glance/watch` — the frame widgets and the Watch notification render. */
class WatchStateDecodeTest {
    private val state = Fixtures.decode<WatchState>("watch-state.json")

    @Test
    fun decodesTheWatchFrame() {
        assertEquals(WatchPhase.WAITING, state.phase)
        assertEquals(3.0, state.needsYouCount)
        assertEquals(1.0, state.runningCount)
        assertEquals(2.0, state.waitingCount)
        assertEquals(5.0, state.recurringCount)
        assertEquals(1.0, state.agentCount)
        assertNull(state.offlineSince)
        assertNull(state.summary)

        val head = assertNotNull(state.head)
        assertEquals(WatchItemKind.LOCAL, head.kind)
        assertEquals("Waiting on a permission", head.reason)
        assertEquals("optio://local/0b7e6f4a-2c1d-4e9b-8a3f-5d6c7b8a9e01?compose=1", head.link)
        assertEquals(WatchSessionSource.LOCAL_TERMINAL, head.source)
        assertEquals(WatchWhereTarget.MACHINE, head.where?.target)
        assertEquals("mbp · ~/optio/apps/web", head.where?.detail)
        assertEquals(WatchThen.WAITS_FOR_ME, head.then)
        assertNull(head.snoozedUntil)

        // Watch dates are Apple reference-date seconds (see packages/shared/src/types/glance.ts).
        val appleEpoch = Instant.parse("2001-01-01T00:00:00Z")
        assertEquals(Instant.parse("2026-09-22T16:30:59Z"), appleEpoch.plusSeconds(head.since.toLong()))

        val task = state.others[0]
        assertEquals(WatchItemKind.TASK, task.kind)
        assertEquals("https://github.com/acme/web/pull/42", task.prUrl)
        assertEquals(WatchSessionSource.REPO_TASK, task.source)
        assertEquals(WatchWhereTarget.POD, task.where?.target)
        assertEquals(WatchThen.EXITS, task.then)
    }

    @Test
    fun rowsFromANewerServerKeepDecoding() {
        val drone = state.others[1]
        assertEquals(WatchItemKind.UNKNOWN, drone.kind)
        assertEquals(WatchSessionSource.UNKNOWN, drone.source)
        assertEquals(WatchWhereTarget.UNKNOWN, drone.where?.target)
        assertNull(drone.where?.detail)
        assertEquals(WatchThen.UNKNOWN, drone.then)
        assertEquals("hovering", drone.state)
        assertNull(drone.who)
    }

    @Test
    fun aWatchItemRoundTrips() {
        val item = WatchItem(
            kind = WatchItemKind.AGENT,
            id = "a1",
            title = "Forge",
            mono = "forge",
            since = 811787459.0,
            state = "running",
            link = "optio://agents/a1",
            then = WatchThen.WAITS_FOR_MESSAGES,
        )
        val json = OptioJson.encodeToString(WatchItem.serializer(), item)
        assertEquals(
            """{"kind":"agent","id":"a1","title":"Forge","mono":"forge","since":8.11787459E8,"state":"running","link":"optio://agents/a1","then":"waits-for-messages"}""",
            json,
        )
        assertEquals(item, OptioJson.decodeFromString(WatchItem.serializer(), json))
    }
}
