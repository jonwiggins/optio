package dev.optio.core.ui.usage

import dev.optio.core.model.AgentLimitWindow
import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalHostAgentLimits
import dev.optio.core.model.LocalHostState
import dev.optio.core.model.OptioJson
import dev.optio.core.ui.format.isoInstant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.Serializable

/**
 * Port of iOS `ProviderLimitsTests` (itself mirroring `collectProviderLimits` / `windowLabel` /
 * `resetsIn` in `apps/web/src/components/dashboard/limits-panel.tsx`): the pure projection the
 * limits panel and the header pill draw from.
 */
class ProviderLimitsTest {
    private val now = checkNotNull("2026-09-19T23:00:00Z".isoInstant())

    private fun host(id: String, codex: LocalHostAgentLimits.Codex?) = LocalHost(
        id = id,
        name = id,
        hostname = id,
        platform = "darwin",
        dirs = emptyList(),
        agentLimits = codex?.let { LocalHostAgentLimits(codex = it) },
        state = LocalHostState.ONLINE,
        createdAt = "2026-01-01T00:00:00Z",
        updatedAt = "2026-01-01T00:00:00Z",
    )

    @Test
    fun windowLabel() {
        assertEquals("5h", UsageLimits.windowLabel(300.0, fallback = "x"))
        assertEquals("7d", UsageLimits.windowLabel(10080.0, fallback = "x"))
        assertEquals("90m", UsageLimits.windowLabel(90.0, fallback = "x"))
        assertEquals("5h", UsageLimits.windowLabel(null, fallback = "5h"))
        assertEquals("7d", UsageLimits.windowLabel(0.0, fallback = "7d"))
    }

    @Test
    fun claudeLiveWindowsAndPerModelBuckets() {
        val usage = ClaudeUsageData(
            available = true,
            fiveHour = UsageWindow(utilization = 31.0, resetsAt = "2026-09-19T23:20:00Z"),
            sevenDay = UsageWindow(utilization = 52.0, resetsAt = "2026-09-20T21:00:00Z"),
            sevenDayModels = listOf(
                UsageModelWindow(model = "Fable", utilization = 88.0, resetsAt = null, severity = "warning"),
                UsageModelWindow(model = "Opus", utilization = null, resetsAt = null, severity = null),
            ),
        )
        val out = UsageLimits.collectProviderLimits(usage, hosts = emptyList(), now = now)
        assertEquals(listOf(ProviderLimits.Key.CLAUDE), out.map { it.key })
        assertEquals("account, live", out[0].source)
        assertNull(out[0].observedAt)
        assertEquals(listOf("5h", "7d", "7d Fable"), out[0].windows.map { it.label })
        assertEquals(listOf(31.0, 52.0, 88.0), out[0].windows.map { it.window.usedPercent })
        assertEquals("2026-09-19T23:20:00Z", out[0].windows[0].window.resetsAt)
    }

    @Test
    fun unavailableOrEmptyClaudeIsOmitted() {
        assertTrue(UsageLimits.collectProviderLimits(usage = null, hosts = emptyList(), now = now).isEmpty())
        assertTrue(UsageLimits.collectProviderLimits(ClaudeUsageData(available = false), emptyList(), now).isEmpty())
        val noNumbers = ClaudeUsageData(available = true, fiveHour = UsageWindow(utilization = null, resetsAt = null))
        assertTrue(UsageLimits.collectProviderLimits(noNumbers, emptyList(), now).isEmpty())
    }

    @Test
    fun codexPicksFreshestHostAndLabelsByWindowLength() {
        val old = LocalHostAgentLimits.Codex(
            primary = AgentLimitWindow(usedPercent = 90.0, windowMinutes = 300.0, resetsAt = "2026-09-20T01:00:00Z"),
            planType = "plus",
            observedAt = "2026-09-18T10:00:00Z",
        )
        val fresh = LocalHostAgentLimits.Codex(
            primary = AgentLimitWindow(usedPercent = 12.0, windowMinutes = 300.0, resetsAt = "2026-09-20T01:00:00Z"),
            secondary = AgentLimitWindow(usedPercent = 40.0, windowMinutes = 10080.0, resetsAt = "2026-09-25T00:00:00Z"),
            planType = "pro",
            observedAt = "2026-09-19T22:00:00Z",
        )
        val out = UsageLimits.collectProviderLimits(
            usage = null,
            hosts = listOf(host("a", old), host("b", fresh), host("c", null)),
            now = now,
        )
        assertEquals(listOf(ProviderLimits.Key.CODEX), out.map { it.key })
        val codex = out[0]
        assertEquals("2026-09-19T22:00:00Z", codex.observedAt)
        assertEquals("pro", codex.planType)
        assertEquals(listOf("5h", "7d"), codex.windows.map { it.label })
        assertEquals(listOf(12.0, 40.0), codex.windows.map { it.window.usedPercent })
        assertEquals(10080.0, codex.windows[1].window.windowMinutes)
    }

    @Test
    fun codexWindowThatAlreadyResetReadsZero() {
        val codex = LocalHostAgentLimits.Codex(
            primary = AgentLimitWindow(usedPercent = 5.0, windowMinutes = 10080.0, resetsAt = "2026-08-18T07:45:45.000Z"),
            secondary = null,
            planType = "prolite",
            observedAt = "2026-08-11T10:27:17.920Z",
        )
        val out = UsageLimits.collectProviderLimits(usage = null, hosts = listOf(host("m1", codex)), now = now)
        assertEquals(1, out.size)
        assertEquals(1, out[0].windows.size)
        assertEquals("7d", out[0].windows[0].label)
        assertEquals(0.0, out[0].windows[0].window.usedPercent)
        assertNull(out[0].windows[0].window.resetsAt)
    }

    @Test
    fun providerOrderIsClaudeThenCodex() {
        val usage = ClaudeUsageData(available = true, fiveHour = UsageWindow(utilization = 10.0, resetsAt = null))
        val codex = LocalHostAgentLimits.Codex(
            primary = AgentLimitWindow(usedPercent = 1.0, windowMinutes = 300.0, resetsAt = null),
            observedAt = "2026-09-19T00:00:00Z",
        )
        val out = UsageLimits.collectProviderLimits(usage, hosts = listOf(host("m1", codex)), now = now)
        assertEquals(listOf(ProviderLimits.Key.CLAUDE, ProviderLimits.Key.CODEX), out.map { it.key })
    }

    @Test
    fun resetsIn() {
        assertEquals("6m", UsageLimits.resetsIn("2026-09-19T23:06:00Z", now))
        assertEquals("21h 46m", UsageLimits.resetsIn("2026-09-20T20:46:00Z", now))
        assertEquals("2d 2h", UsageLimits.resetsIn("2026-09-22T01:00:00Z", now))
        assertNull(UsageLimits.resetsIn("2026-09-19T22:59:00Z", now))
        assertNull(UsageLimits.resetsIn(null, now))
        assertNull(UsageLimits.resetsIn("not a date", now))
    }

    @Test
    fun percentClampsAndRounds() {
        assertEquals(30, UsageLimits.percent(30.4))
        assertEquals(31, UsageLimits.percent(30.5))
        assertEquals(0, UsageLimits.percent(-3.0))
        assertEquals(100, UsageLimits.percent(140.0))
        assertEquals(0, UsageLimits.percent(null))
    }

    @Test
    fun severityThresholds() {
        assertEquals(UsageSeverity.LOW, UsageSeverity.of(0))
        assertEquals(UsageSeverity.LOW, UsageSeverity.of(49))
        assertEquals(UsageSeverity.NORMAL, UsageSeverity.of(50))
        assertEquals(UsageSeverity.WARNING, UsageSeverity.of(80))
        assertEquals(UsageSeverity.CRITICAL, UsageSeverity.of(95))
        assertFalse(UsageSeverity.of(79).isElevated)
        assertTrue(UsageSeverity.of(80).isElevated)
    }

    @Test
    fun staleAge() {
        assertEquals("under a minute", UsageLimits.staleAge("2026-09-19T22:59:40Z", now))
        assertEquals("45m", UsageLimits.staleAge("2026-09-19T22:15:00Z", now))
        assertEquals("3h", UsageLimits.staleAge("2026-09-19T20:00:00Z", now))
        assertEquals("2h 30m", UsageLimits.staleAge("2026-09-19T20:30:00Z", now))
    }

    @Serializable
    private data class Envelope(val usage: ClaudeUsageData)

    @Test
    fun usageEnvelopeDecodes() {
        val json = """
            {"usage":{"available":true,"fiveHour":{"utilization":31,"resetsAt":"2026-09-19T23:20:00.601836+00:00"},
            "sevenDay":{"utilization":52,"resetsAt":"2026-09-20T21:00:00.601859+00:00"},
            "sevenDayModels":[{"model":"Fable","utilization":12,"resetsAt":null,"severity":null}],
            "extraUsage":{"isEnabled":false,"monthlyLimit":16500,"usedCredits":0,"utilization":0},
            "asOf":"2026-09-19T23:11:13.942Z","hasRecentAuthFailure":false,"authFailures":{"claude":false,"github":false}}}
        """.trimIndent()
        val u = OptioJson.decodeFromString<Envelope>(json).usage
        assertTrue(u.available)
        assertEquals(31.0, u.fiveHour?.utilization)
        assertEquals("Fable", u.sevenDayModels?.first()?.model)
        assertEquals("2026-09-19T23:11:13.942Z", u.asOf)
        assertFalse(u.claudeAuthFailed)
        assertEquals(listOf("5h", "7d", "7d Fable"), UsageLimits.claudeBuckets(u).map { it.label })
    }

    @Test
    fun authFailureDetection() {
        assertTrue(ClaudeUsageData(available = false, error = "OAuth token has expired").claudeAuthFailed)
        assertTrue(ClaudeUsageData(available = false, error = "HTTP 401 from Anthropic").claudeAuthFailed)
        assertFalse(ClaudeUsageData(available = false, error = "No Claude subscription credentials found on this host").claudeAuthFailed)
        assertTrue(ClaudeUsageData(available = true, hasRecentAuthFailure = true).claudeAuthFailed)
        // An explicit per-token flag wins over the legacy one.
        assertFalse(ClaudeUsageData(available = true, hasRecentAuthFailure = true, authFailures = AuthFailures(claude = false, github = true)).claudeAuthFailed)
        assertTrue(ClaudeUsageData(authFailures = AuthFailures(github = true)).githubAuthFailed)
        assertFalse(ClaudeUsageData().githubAuthFailed)
    }
}
