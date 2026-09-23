package dev.optio.core.glance

import dev.optio.core.data.DeepLink
import dev.optio.core.model.OptioJson
import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchPhase
import dev.optio.core.model.WatchSessionSource
import dev.optio.core.model.WatchState
import dev.optio.core.model.WatchThen
import dev.optio.core.model.WatchWhere
import dev.optio.core.model.WatchWhereTarget
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Port of iOS `OptioTests/WatchSessionsTests.swift`: the Watch wire contract after the Sessions
 * redesign. The session chips and board tiles are optional and additive (frames from older servers
 * still decode, and the fallbacks give every row four chips), `NeedsYouSnapshot` carries the tiles
 * into the Watch state, and the new deep links round-trip. (The router half of the Swift test is in
 * `:feature:glance`'s `WatchRouterTest`, where `AppRouter` is available.)
 */
class WatchSessionsTest {
    private fun decode(json: String): GlanceWatchState = GlanceWatchState.fromWire(OptioJson.decodeFromString(WatchState.serializer(), json))

    // region Wire

    @Test
    fun frameWithSessionFieldsDecodes() {
        val state =
            decode(
                """
                {"phase":"waiting","head":{"kind":"local","id":"t1","title":"claude-code · web","mono":"web",
                  "reason":"Waiting on a permission","since":811397599,"state":"needs_you","link":"optio://local/t1?compose=1",
                  "source":"local-terminal","when":"now","where":{"target":"machine","detail":"mbp · ~/optio/apps/web"},
                  "who":"claude-code","then":"waits-for-me","statusLabel":"needs you"},
                 "others":[],"needsYouCount":1,"runningCount":2,"waitingCount":1,"recurringCount":4,"agentCount":2,"asOf":811397839}
                """.trimIndent(),
            )
        assertEquals(WatchPhase.WAITING, state.phase)
        assertEquals(1, state.waitingCount)
        assertEquals(4, state.recurringCount)
        assertEquals(2, state.agentCount)
        val head = assertNotNull(state.head)
        assertEquals(WatchSessionSource.LOCAL_TERMINAL, head.source)
        assertEquals("now", head.whenLabel)
        assertEquals(WatchWhere(WatchWhereTarget.MACHINE, "mbp · ~/optio/apps/web"), head.whereValue)
        assertEquals("claude-code", head.whoValue)
        assertFalse(head.whoIsTerminal)
        assertEquals(WatchThen.WAITS_FOR_ME, head.thenValue)
        assertEquals("needs you", head.statusText)
        // Apple reference seconds: 811_397_599 + 978_307_200 unix.
        assertEquals(Instant.ofEpochSecond(811_397_599L + 978_307_200L), head.since)
        assertEquals(Instant.ofEpochSecond(811_397_839L + 978_307_200L), state.asOf)
    }

    @Test
    fun legacyFrameDecodesWithFallbacks() {
        // A frame from a server that predates the session fields: the sample payload shape.
        val state =
            decode(
                """
                {"phase":"waiting","head":{"kind":"local","id":"t1","title":"claude-code · optio","mono":"repos/optio/apps/web",
                  "reason":"Waiting on a permission","preview":"Allow?","since":811397599,"state":"needs_you",
                  "link":"optio://local/t1?compose=1","prUrl":null,"snoozedUntil":null},
                 "others":[{"kind":"task","id":"k","title":"docs","mono":"docs/readme","reason":"PR #581 open · CI running",
                  "since":811397119,"state":"pr_opened","link":"optio://tasks/k","prUrl":"https://x/pull/581"}],
                 "needsYouCount":2,"runningCount":3,"offlineSince":null,"summary":null,"asOf":811397839}
                """.trimIndent(),
            )
        assertNull(state.waitingCount)
        assertNull(state.recurringCount)
        assertNull(state.agentCount)

        val local = assertNotNull(state.head)
        assertNull(local.source)
        assertEquals("now", local.whenLabel)
        assertEquals(WatchWhere(WatchWhereTarget.MACHINE, "repos/optio/apps/web"), local.whereValue)
        assertEquals("claude-code", local.whoValue, "agent named in the default terminal title")
        assertEquals(WatchThen.WAITS_FOR_ME, local.thenValue)
        assertEquals("needs you", local.statusText)

        val task = state.others[0]
        assertEquals(WatchWhere(WatchWhereTarget.POD, "docs/readme"), task.whereValue)
        assertEquals("claude-code", task.whoValue)
        assertEquals(WatchThen.EXITS, task.thenValue)
        assertEquals("PR open", task.statusText)

        val agent = item(WatchItemKind.AGENT, "a", "Vesper", "@vesper", state = "running", link = "optio://agents/a")
        assertEquals("messages", agent.whenLabel)
        assertEquals(WatchThen.WAITS_FOR_MESSAGES, agent.thenValue)
        assertEquals(GlanceIcon.CPU, agent.whenIcon)

        val shell = item(WatchItemKind.LOCAL, "s", "zsh", "notes", state = "needs_you", link = "optio://local/s")
        assertEquals("terminal", shell.whoValue)
        assertTrue(shell.whoIsTerminal)
        assertEquals(GlanceIcon.TERMINAL, shell.whoIcon)
    }

    @Test
    fun encodingRoundTripsSessionFields() {
        val item =
            GlanceItem(
                kind = WatchItemKind.TASK,
                id = "t",
                title = "Fix",
                mono = "fix/x",
                since = AppleTime.toInstant(1.0),
                state = "running",
                link = "optio://tasks/t",
                source = WatchSessionSource.REPO_TASK,
                `when` = "on a trigger",
                where = WatchWhere(WatchWhereTarget.POD, "acme/web"),
                who = "codex",
                then = WatchThen.EXITS,
                statusLabel = "running",
            )
        val wire = OptioJson.encodeToJsonElement(dev.optio.core.model.WatchItem.serializer(), item.toWire()).jsonObject
        val back = GlanceItem.from(OptioJson.decodeFromJsonElement(dev.optio.core.model.WatchItem.serializer(), wire))
        assertEquals(item, back)
        assertEquals("pod", wire["where"]!!.jsonObject["target"]!!.jsonPrimitive.content)
        assertEquals("acme/web", wire["where"]!!.jsonObject["detail"]!!.jsonPrimitive.content)
        assertEquals("exits", wire["then"]!!.jsonPrimitive.content)
        assertEquals("repo-task", wire["source"]!!.jsonPrimitive.content)
        assertEquals(1.0, wire["since"]!!.jsonPrimitive.content.toDouble())
    }

    // endregion

    // region Snapshot → Watch state

    @Test
    fun snapshotCarriesTilesIntoWatchState() {
        val now = Instant.parse("2026-09-22T16:40:00Z")
        val need = item(WatchItemKind.LOCAL, "a", "a", "a", since = now.minusSeconds(60), state = "needs_you", link = "optio://local/a")
        val run = item(WatchItemKind.LOCAL, "b", "b", "b", since = now, state = "working", link = "optio://local/b")
        val counts = SessionTileCounts(waiting = 2, recurring = 3, agents = 4)
        val waiting = NeedsYouSnapshot(listOf(need), listOf(run), 1, 1, counts, now).watchState()
        assertEquals(WatchPhase.WAITING, waiting.phase)
        assertEquals(2, waiting.waitingCount)
        assertEquals(3, waiting.recurringCount)
        assertEquals(4, waiting.agentCount)

        val working = NeedsYouSnapshot(emptyList(), listOf(run), 1, 1, counts, now).watchState()
        assertEquals(WatchPhase.WORKING, working.phase)
        assertEquals(3, working.recurringCount)

        val legacy = NeedsYouSnapshot(emptyList(), listOf(run), 1, 1, asOf = now).watchState()
        assertNull(legacy.recurringCount)
    }

    @Test
    fun mergeSumsTilesAcrossServers() {
        var a = NeedsYouSnapshot(hostsOnline = 1, hostsTotal = 1, counts = SessionTileCounts(1, 2, 3))
        val b = NeedsYouSnapshot(hostsOnline = 0, hostsTotal = 1, counts = SessionTileCounts(10, 20, 30))
        val legacy = NeedsYouSnapshot(hostsOnline = 1, hostsTotal = 1)
        a = a.merge(b)
        assertEquals(SessionTileCounts(11, 22, 33), a.counts)
        assertEquals(2, a.hostsTotal)
        a = a.merge(legacy)
        assertEquals(SessionTileCounts(11, 22, 33), a.counts, "a server without tiles adds nothing")
        assertNull(legacy.merge(legacy).counts)
    }

    @Test
    fun cachedSnapshotWithoutTilesStillDecodes() {
        // Older caches have no `counts` key.
        val json = """{"needsYou":[],"running":[],"hostsOnline":1,"hostsTotal":1,"asOf":"2026-09-17T12:00:00Z"}"""
        val snap = OptioJson.decodeFromString(NeedsYouSnapshot.serializer(), json)
        assertNull(snap.counts)
        assertEquals(Instant.parse("2026-09-17T12:00:00Z"), snap.asOf)
    }

    @Test
    fun shortDirAndRepo() {
        assertEquals("~/repos/optio/apps/web", NeedsYouSnapshot.shortDir("/Users/jon/repos/optio/apps/web"))
        assertEquals("~/x", NeedsYouSnapshot.shortDir("/home/dev/x"))
        assertEquals("~", NeedsYouSnapshot.shortDir("/Users/jon"))
        assertEquals("/srv/app", NeedsYouSnapshot.shortDir("/srv/app"))
        assertEquals("acme/web", NeedsYouSnapshot.shortRepo("https://github.com/acme/web.git"))
        assertEquals("g/sub/repo", NeedsYouSnapshot.shortRepo("https://gitlab.example.com/g/sub/repo"))
        assertNull(NeedsYouSnapshot.shortRepo(null))
        assertEquals("idle", NeedsYouSnapshot.terminalStatusLabel("running", "idle"))
        assertEquals("exited", NeedsYouSnapshot.terminalStatusLabel("exited", "needs_you"))
        assertEquals("needs attention", NeedsYouSnapshot.taskStatusLabel("needs_attention"))
        assertEquals("PR open", NeedsYouSnapshot.taskStatusLabel("pr_opened"))
    }

    // endregion

    // region Deep links

    @Test
    fun newWorkAndWorkViewLinks() {
        assertEquals("optio://work/new", DeepLink.NewWork.url)
        assertEquals(DeepLink.NewWork, DeepLink.parse("optio://work/new"))
        // The pre-v0.6 link still opens the form.
        assertEquals(DeepLink.NewWork, DeepLink.parse("optio://sessions/new"))
        assertEquals(DeepLink.Session("abc"), DeepLink.parse("optio://sessions/abc"), "ids other than `new` still open a pod session")

        val active = DeepLink.Work("active").url
        assertEquals("optio://section/work?view=active", active)
        assertEquals(DeepLink.Work("active"), DeepLink.parse(active))
        assertEquals(DeepLink.Work("recurring"), DeepLink.parse("optio://section/sessions?view=recurring"))
        assertEquals(DeepLink.Section("sessions"), DeepLink.parse("optio://section/sessions"))
        assertEquals("s1", DeepLink.serverId(DeepLink.Work("agents").url(server = "s1")))
    }

    // endregion

    private fun item(
        kind: WatchItemKind,
        id: String,
        title: String,
        mono: String,
        since: Instant = Instant.parse("2026-09-22T16:40:00Z"),
        state: String,
        link: String,
    ) = GlanceItem(kind = kind, id = id, title = title, mono = mono, since = since, state = state, link = link)
}
