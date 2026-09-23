package dev.optio.core.workfeed

import dev.optio.core.navigation.WorkView
import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.Fixtures
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.runBlocking

/**
 * The six endpoints as the private test API answered them (DevLab seed, captured into
 * `src/test/resources/fixtures/work-*.json`), decoded and projected, compared line by line with
 * `work-feed-web-golden.txt`: the output of the web's own `collectWork` / `countWork` / `inView`
 * (`apps/web/src/lib/work-feed.ts`, run with tsx) over the same six files. The golden rows are
 * `key | status | statusLabel | name | when | target | detail | who | then | note | prUrl |
 * lastActivity | recurring | spawned` (JS `join` prints null as empty), then the counts and the
 * size of each view.
 */
class WorkFeedFixturesTest {
    private val server = FakeOptioServer().start()

    @AfterTest
    fun tearDown() = server.close()

    private fun serveSeed() {
        server.fixture(WorkFeedEndpoints.UNIFIED, "work-tasks-unified.json")
        server.fixture(WorkFeedEndpoints.LOCAL_TERMINALS, "work-local-terminals.json")
        server.fixture(WorkFeedEndpoints.LOCAL_BLUEPRINTS, "work-local-blueprints.json")
        server.fixture(WorkFeedEndpoints.POD_SESSIONS, "work-sessions.json")
        server.fixture(WorkFeedEndpoints.AGENTS, "work-persistent-agents.json")
        server.fixture(WorkFeedEndpoints.LOCAL_HOSTS, "work-local-hosts.json")
    }

    private fun WorkRow.goldenLine(): String =
        listOf(
            key, status.id, statusLabel, name, whenLabel, where.target.name.lowercase(), where.detail, who, then.raw,
            note, prUrl, lastActivity, recurring, spawned,
        ).joinToString(" | ") { it?.toString().orEmpty() }

    private fun WorkCounts.goldenJson(): String =
        """{"needsYou":$needsYou,"running":$running,"waiting":$waiting,"recurring":$recurring,"agents":$agents}"""

    @Test
    fun theSeedProjectsExactlyLikeTheWeb() = runBlocking {
        serveSeed()
        val rows = WorkFeed.collect(server.client().workFeedSources())

        val actual = buildList {
            rows.forEach { add(it.goldenLine()) }
            add(WorkFeed.count(rows).goldenJson())
            WorkView.entries.forEach { view -> add("${view.raw} ${rows.count { WorkFeed.inView(it, view) }}") }
        }
        val golden = Fixtures.text("work-feed-web-golden.txt").trimEnd('\n').split('\n')
        assertEquals(golden.size, actual.size, "line count")
        golden.zip(actual).forEachIndexed { index, (want, got) -> assertEquals(want, got, "line ${index + 1}") }
    }

    @Test
    fun theSeedCoversEveryKindOfWork() = runBlocking {
        serveSeed()
        val rows = WorkFeed.collect(server.client().workFeedSources())
        assertEquals(WorkSource.entries.toSet(), rows.map { it.source }.toSet(), "every source is represented")
        assertEquals(
            setOf(WorkStatus.NEEDS_YOU, WorkStatus.RUNNING, WorkStatus.QUEUED, WorkStatus.WAITING, WorkStatus.SCHEDULED, WorkStatus.PAUSED, WorkStatus.FAILED, WorkStatus.DONE),
            rows.map { it.status }.toSet(),
            "every status is represented",
        )
        // The local run of the queued task is its tasks row, not a second terminal row.
        assertEquals(1, rows.count { it.name == "Fix the Safari date picker" })
    }
}
