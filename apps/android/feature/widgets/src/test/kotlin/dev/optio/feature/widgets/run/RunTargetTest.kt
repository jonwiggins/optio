package dev.optio.feature.widgets.run

import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.junit.Test

/** iOS `RunTargetEntity` id namespacing: `<serverId>|local:<uuid>` / `<serverId>|job:<uuid>`. */
class RunTargetTest {
    @Test
    fun makeIdNamespacesByServer() {
        assertEquals("srv-1|local:abc", RunTarget.makeId("srv-1", RunTarget.Kind.LOCAL, "abc"))
        assertEquals("srv-1|job:def", RunTarget.makeId("srv-1", RunTarget.Kind.JOB, "def"))
        assertEquals("job:def", RunTarget.makeId(null, RunTarget.Kind.JOB, "def"), "no server → legacy form")
    }

    @Test
    fun parseRoundTrips() {
        for (server in listOf("srv-1", "dev-server_2", null)) {
            for (kind in RunTarget.Kind.entries) {
                val id = RunTarget.makeId(server, kind, "9b2c-uuid")
                assertEquals(RunTarget.Parts(kind, "9b2c-uuid", server), RunTarget.parse(id), id)
            }
        }
    }

    @Test
    fun parseRejectsMalformedIds() {
        assertNull(RunTarget.parse("nonsense"))
        assertNull(RunTarget.parse("srv|nonsense"))
        assertNull(RunTarget.parse("task:abc"), "only local and job fire")
        assertNull(RunTarget.parse(""))
    }

    @Test
    fun rawIdKeepsColonsAfterTheKind() {
        // Only the first ':' separates the kind (Swift splits at the first colon too).
        assertEquals(RunTarget.Parts(RunTarget.Kind.JOB, "a:b", "s"), RunTarget.parse("s|job:a:b"))
    }

    @Test
    fun firePathsPerKind() {
        assertEquals("/api/local/blueprints/abc/spawn", target("srv|local:abc").firePath)
        assertEquals("/api/jobs/def/runs", target("srv|job:def").firePath)
        assertEquals("/api/jobs/def/runs", target("job:def").firePath)
        assertNull(target("bogus").firePath)
    }

    @Test
    fun serverAndRawIdAccessors() {
        val t = target("dev-server_2|local:uuid-1")
        assertEquals("dev-server_2", t.serverId)
        assertEquals("uuid-1", t.rawId)
        assertNull(target("local:uuid-1").serverId, "legacy ids fire on the active server")
    }

    @Test
    fun subtitleNamesTheServerOnlyWhenSet() {
        assertEquals("Job", RunTarget("s|job:1", "Nightly", RunTarget.Kind.JOB).subtitle)
        assertEquals("Local blueprint · MacBook", RunTarget("s|local:1", "Deploy", RunTarget.Kind.LOCAL, serverName = "MacBook").subtitle)
        assertEquals("blueprint", RunTarget("s|local:1", "Deploy", RunTarget.Kind.LOCAL).kindWord)
        assertEquals("job", RunTarget("s|job:1", "Nightly", RunTarget.Kind.JOB).kindWord)
    }

    @Test
    fun resolveMatchesExactIdsFirst() {
        val all = listOf(RunTarget("a|job:1", "Nightly", RunTarget.Kind.JOB), RunTarget("b|job:1", "Nightly (b)", RunTarget.Kind.JOB))
        assertEquals(listOf(all[1]), RunTarget.resolve(listOf("b|job:1"), all))
    }

    @Test
    fun resolveMapsLegacyIdsToTheActiveServersTarget() {
        // `all` lists the active server first; a legacy id takes the first matching kind + raw id.
        val all = listOf(RunTarget("active|local:x", "Deploy", RunTarget.Kind.LOCAL, "auto"), RunTarget("other|local:x", "Deploy (other)", RunTarget.Kind.LOCAL))
        val resolved = RunTarget.resolve(listOf("local:x"), all)
        assertEquals(listOf(RunTarget("local:x", "Deploy", RunTarget.Kind.LOCAL, "auto")), resolved, "keeps the configured id")
    }

    @Test
    fun resolveKeepsMissingTargetsAsPlaceholders() {
        val resolved = RunTarget.resolve(listOf("gone|job:1", "gone|local:2"), emptyList()) { id -> if (id == "gone") "Studio" else null }
        assertEquals(
            listOf(
                RunTarget("gone|job:1", "Job", RunTarget.Kind.JOB, serverName = "Studio"),
                RunTarget("gone|local:2", "Blueprint", RunTarget.Kind.LOCAL, serverName = "Studio"),
            ),
            resolved,
        )
        assertEquals(emptyList(), RunTarget.resolve(listOf("bogus"), emptyList()), "malformed ids resolve to nothing")
    }

    private fun target(id: String) = RunTarget(id, "x", RunTarget.parse(id)?.kind ?: RunTarget.Kind.JOB)
}
