package dev.optio.core.model

import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test

class LocalDecodeTest {
    @Serializable
    private data class TerminalsResponse(val terminals: List<LocalTerminal>)

    @Serializable
    private data class HostsResponse(val hosts: List<LocalHost>)

    private val terminals = Fixtures.decode<TerminalsResponse>("local-terminals.json").terminals

    @Test
    fun decodesAnAgentTerminal() {
        val t = terminals[0]
        assertEquals("claude-code · web", t.title)
        assertEquals(LocalTerminalState.RUNNING, t.state)
        assertEquals(LocalAttentionState.NEEDS_YOU, t.attentionState)
        assertEquals(LocalSpawnSource.MANUAL, t.spawnedBy)
        assertNull(t.exitCode)
        assertEquals("2026-09-22T16:12:01.337Z", t.startedAt)

        val spec = assertIs<LocalTerminalSpec.Agent>(t.spec)
        assertEquals(LocalAgentKind.CLAUDE_CODE, spec.agent)
        assertEquals(LocalAgentSessionMode.INTERACTIVE, spec.mode)
        assertEquals("main", spec.baseBranch)
        assertNull(spec.resumeSessionId)

        assertEquals(2, t.links.size)
        assertEquals(WorkLinkKind.PR, t.links[0].kind)
        assertEquals(WorkLinkProvider.GITHUB, t.links[0].provider)
        assertEquals(WorkLinkKind.REF, t.links[1].kind)

        // `LocalTerminalUsage` lives outside the generated inputs, so it stays raw JSON.
        val usage = assertNotNull(t.usage).jsonObject
        assertEquals("3", usage.getValue("turns").jsonPrimitive.content)
    }

    @Test
    fun decodesShellAndCommandTerminals() {
        val shell = terminals[1]
        assertEquals(LocalTerminalSpec.Shell, shell.spec)
        assertEquals(LocalTerminalState.EXITED, shell.state)
        assertEquals(0.0, shell.exitCode)
        assertNull(shell.userId)
        assertNull(shell.snoozedUntil) // absent from the row
        assertTrue(shell.links.isEmpty())

        val command = terminals[2]
        assertEquals(LocalTerminalSpec.Command("pnpm lint"), command.spec)
        assertEquals(LocalTerminalPendingReason.HOST_OFFLINE, command.pendingReason)
        assertEquals(LocalSpawnSource.TRIGGER, command.spawnedBy)
        assertEquals("2026-09-22T18:00:00.000Z", command.snoozedUntil)
    }

    @Test
    fun aTerminalFromANewerServerStillDecodes() {
        val t = terminals[3]
        val spec = assertIs<LocalTerminalSpec.Unknown>(t.spec)
        assertEquals(JsonPrimitive("devcontainer"), spec.raw.jsonObject["kind"])
        assertEquals(JsonPrimitive("node:24"), spec.raw.jsonObject["image"])
        assertEquals(LocalTerminalState.UNKNOWN, t.state)
        assertEquals(LocalTerminalPendingReason.UNKNOWN, t.pendingReason)
        assertEquals(LocalAttentionState.UNKNOWN, t.attentionState)
        assertEquals(LocalSpawnSource.UNKNOWN, t.spawnedBy)
        assertEquals(WorkLinkKind.UNKNOWN, t.links[0].kind)
        assertEquals(WorkLinkProvider.UNKNOWN, t.links[0].provider)
        assertEquals("acme/web!3", t.links[0].label)
    }

    @Test
    fun decodesHosts() {
        val hosts = Fixtures.decode<HostsResponse>("local-hosts.json").hosts
        val mbp = hosts[0]
        assertEquals(LocalHostState.ONLINE, mbp.state)
        assertEquals("darwin", mbp.platform)
        assertEquals(true, mbp.claudeCredentials)
        assertEquals("https://github.com/acme/optio", mbp.dirs[0].repoUrl)
        assertNull(mbp.dirs[1].repoUrl)
        val codex = assertNotNull(mbp.agentLimits?.codex)
        assertEquals(42.5, codex.primary?.usedPercent)
        assertEquals(300.0, codex.primary?.windowMinutes)
        assertNull(codex.secondary?.windowMinutes)
        assertEquals("pro", codex.planType)

        val box = hosts[1]
        assertEquals(LocalHostState.OFFLINE, box.state)
        assertNull(box.agentLimits)
        assertNull(box.claudeCredentials)
        assertNull(box.arch)
        assertNull(box.lastSeenAt)
    }

    @Test
    fun aTerminalSpecRoundTripsWithItsDiscriminator() {
        val spec: LocalTerminalSpec = LocalTerminalSpec.Agent(
            agent = LocalAgentKind.CODEX,
            prompt = "Fix the build",
            mode = LocalAgentSessionMode.HEADLESS,
        )
        val json = OptioJson.encodeToString(LocalTerminalSpec.serializer(), spec)
        assertEquals("""{"kind":"agent","agent":"codex","prompt":"Fix the build","mode":"headless"}""", json)
        assertEquals(spec, OptioJson.decodeFromString(LocalTerminalSpec.serializer(), json))
        assertEquals(
            """{"kind":"shell"}""",
            OptioJson.encodeToString(LocalTerminalSpec.serializer(), LocalTerminalSpec.Shell),
        )
    }
}
