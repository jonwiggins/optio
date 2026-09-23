package dev.optio.feature.local.live

import dev.optio.core.model.LocalAgentKind
import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalBlueprintSpawnMode
import dev.optio.core.model.LocalHostState
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.LocalTerminalSpec
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.network.ApiClient
import dev.optio.core.terminal.TerminalGrid
import dev.optio.core.terminal.TerminalSizing
import dev.optio.feature.local.api.CreateLocalTerminalBody
import dev.optio.feature.local.api.LocalBlueprintBody
import dev.optio.feature.local.api.createLocalBlueprint
import dev.optio.feature.local.api.createLocalBlueprintTrigger
import dev.optio.feature.local.api.createLocalTerminal
import dev.optio.feature.local.api.deleteLocalBlueprint
import dev.optio.feature.local.api.deleteLocalBlueprintTrigger
import dev.optio.feature.local.api.deleteLocalTerminal
import dev.optio.feature.local.api.getLocalTerminal
import dev.optio.feature.local.api.getLocalTerminalTranscript
import dev.optio.feature.local.api.killLocalTerminal
import dev.optio.feature.local.api.listLocalBlueprintTriggers
import dev.optio.feature.local.api.listLocalHosts
import dev.optio.feature.local.api.listLocalTerminals
import dev.optio.feature.local.api.setLocalBlueprintTriggerEnabled
import dev.optio.feature.local.api.snoozeLocalTerminal
import dev.optio.feature.local.api.spawnLocalBlueprint
import dev.optio.feature.local.api.unsnoozeLocalTerminal
import dev.optio.feature.local.api.updateLocalBlueprint
import dev.optio.feature.local.model.LocalPresentation
import dev.optio.feature.local.model.TriggerKind
import dev.optio.feature.local.model.Triggers
import dev.optio.feature.local.stream.FakeSink
import dev.optio.feature.local.stream.LocalTerminalStream
import dev.optio.feature.local.stream.WebSocketStreamSocket
import dev.optio.feature.local.transcript.LocalTranscriptModel
import java.util.concurrent.Executors
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * The Local endpoints and the stream for real, against a private test API with its isolated
 * daemon (`apps/android/scripts/test-api.sh start --port N` + `test-daemon.sh start --port N`):
 *
 *   OPTIO_TEST_API_URL=http://127.0.0.1:N ./gradlew :feature:local:testDebugUnitTest --tests '*LocalLiveTest*' --rerun
 *
 * Skipped when OPTIO_TEST_API_URL is unset. Writes only to what it creates (a throwaway
 * `{kind:"shell"}` terminal in the daemon's `scratch` dir, a throwaway automation) and deletes
 * them; snoozes and unsnoozes the DevLab's recorded session. Never point it at a real server.
 */
class LocalLiveTest {
    private val base: String? = System.getenv("OPTIO_TEST_API_URL")?.trimEnd('/')

    private fun api(): ApiClient {
        assumeTrue("set OPTIO_TEST_API_URL to a private test API", base != null)
        check(!base!!.contains(":30400")) { "never the real server" }
        return ApiClient(base, "dev")
    }

    private suspend fun waitFor(
        what: String,
        timeoutMs: Long = 15_000,
        check: suspend () -> Boolean,
    ) = withTimeout(timeoutMs) {
        while (!check()) delay(100)
    }.also { println("ok: $what") }

    @Test
    fun hostsTerminalsAndTheRecordedTranscript() =
        runBlocking {
            val api = api()
            val hosts = api.listLocalHosts()
            assertTrue(hosts.any { it.state == LocalHostState.ONLINE }, "the test daemon's host is online")
            assertTrue(hosts.any { it.name == "E2E laptop" && it.state == LocalHostState.OFFLINE })

            val terminals = api.listLocalTerminals()
            val recorded = terminals.first { it.spawnedBy.raw == "blueprint" && it.state == LocalTerminalState.EXITED && it.links.isNotEmpty() }
            assertTrue(LocalPresentation.canResume(recorded))
            assertEquals(recorded.id, api.getLocalTerminal(recorded.id).id)

            // Paged exactly as the screen pages it, then nothing new after the last seq.
            val model = LocalTranscriptModel(this, { after, limit -> api.getLocalTerminalTranscript(recorded.id, after, limit) }, pageSize = 5)
            model.start(live = false)
            waitFor("the transcript") { model.state.value.loaded && model.state.value.entries.size == 14 }
            model.stop()
            assertEquals((1..14).map { it.toDouble() }, model.state.value.entries.map { it.seq })
            assertTrue(api.getLocalTerminalTranscript(recorded.id, after = 14).entries.isEmpty())
        }

    @Test
    fun laterSnoozesOnTheServerAndBackAgain() =
        runBlocking {
            val api = api()
            val recorded = api.listLocalTerminals().first { it.attentionState == LocalAttentionState.NEEDS_YOU }
            val snoozed = api.snoozeLocalTerminal(recorded.id, 15)
            assertNotNull(snoozed.snoozedUntil)
            assertNotNull(LocalPresentation.snoozedUntil(snoozed, java.time.Instant.now()))
            assertNull(api.unsnoozeLocalTerminal(recorded.id).snoozedUntil)
        }

    @Test
    fun anAutomationItsTriggersAndARunNow() =
        runBlocking {
            val api = api()
            val host = api.listLocalHosts().first { it.state == LocalHostState.ONLINE }
            val scratch = host.dirs.first { it.path.endsWith("/scratch") }.path
            val bp =
                api.createLocalBlueprint(
                    LocalBlueprintBody(
                        name = "A5 live test (throwaway)",
                        hostId = host.id,
                        dir = scratch,
                        commandTemplate = "echo {{who}}",
                        spawnMode = LocalBlueprintSpawnMode.HOLD,
                    ),
                )
            var spawned: LocalTerminal? = null
            try {
                assertNull(bp.agent, "no agent = a shell command")
                val paused = api.updateLocalBlueprint(bp.id, LocalBlueprintBody(enabled = false))
                assertEquals(false, paused.enabled)
                val moved = api.updateLocalBlueprint(bp.id, LocalBlueprintBody(agent = LocalAgentKind.CLAUDE_CODE))
                assertEquals(LocalAgentKind.CLAUDE_CODE, moved.agent)
                val back = api.updateLocalBlueprint(bp.id, LocalBlueprintBody(clearAgent = true, clearHost = true))
                assertNull(back.agent, "an explicit null clears the agent")
                assertNull(back.hostId)

                val config = Triggers.build(Triggers.Draft(kind = TriggerKind.SCHEDULE, cron = "0 9 * * 1")).getOrThrow()
                val trigger = api.createLocalBlueprintTrigger(bp.id, "schedule", config)
                assertNotNull(trigger.nextFireAt)
                assertEquals("0 9 * * 1", Triggers.summary(trigger))
                assertEquals(false, api.setLocalBlueprintTriggerEnabled(bp.id, trigger.id, false).enabled)
                val gh =
                    api.createLocalBlueprintTrigger(
                        bp.id,
                        "github",
                        Triggers.build(Triggers.Draft(kind = TriggerKind.GITHUB, githubEvents = setOf("pr_opened"))).getOrThrow(),
                    )
                assertEquals("pr_opened", Triggers.summary(gh))
                assertEquals(2, api.listLocalBlueprintTriggers(bp.id).size)
                api.deleteLocalBlueprintTrigger(bp.id, gh.id)
                assertEquals(listOf(trigger.id), api.listLocalBlueprintTriggers(bp.id).map { it.id })

                // A paused automation can't be run by hand either (the UI disables Run while paused).
                val refused = kotlin.runCatching { api.spawnLocalBlueprint(bp.id) }.exceptionOrNull() as dev.optio.core.network.ApiError
                assertEquals(409, refused.status)
                assertEquals("Blueprint is disabled", refused.message)
                api.updateLocalBlueprint(bp.id, LocalBlueprintBody(enabled = true))

                // Run now: a held automation parks its terminal for a one-tap start.
                spawned = api.spawnLocalBlueprint(bp.id)
                assertEquals(LocalTerminalState.PENDING, spawned.state)
                assertEquals("Held", LocalPresentation.stateLabel(spawned))
            } finally {
                spawned?.let { runCatching { api.deleteLocalTerminal(it.id) } }
                api.deleteLocalBlueprint(bp.id)
            }
        }

    @Test
    fun aThrowawayShellAttachesPassivelyThenClaimsAndTypes() =
        runBlocking {
            val api = api()
            val host = api.listLocalHosts().first { it.state == LocalHostState.ONLINE }
            val scratch = host.dirs.first { it.path.endsWith("/scratch") }.path
            val terminal =
                api.createLocalTerminal(CreateLocalTerminalBody(hostId = host.id, dir = scratch, title = "A5 live stream test (throwaway)", spec = LocalTerminalSpec.Shell))
            val thread = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
            val scope = CoroutineScope(SupervisorJob() + thread)
            val sink = FakeSink(natural = TerminalGrid(50, 20))
            var stream: LocalTerminalStream? = null
            try {
                waitFor("running") { api.getLocalTerminal(terminal.id).state == LocalTerminalState.RUNNING }
                val s =
                    withContext(thread) {
                        LocalTerminalStream(terminal.id, scope, sink, openSocket = { WebSocketStreamSocket.open(api, terminal.id) }).also {
                            sink.onGridSizeChanged = it::onGridSizeChanged
                            it.connect()
                        }
                    }
                stream = s
                waitFor("the size frame") { withContext(thread) { s.state.value.connected && s.state.value.foreignGrid != null } }
                // Attaching never resizes the PTY: we render the daemon's grid, passively.
                val announced = withContext(thread) { s.state.value.foreignGrid!! }
                assertTrue(announced != TerminalGrid(50, 20), "the daemon's own grid, got $announced")

                // Typing is an explicit interaction: the grid is claimed (resized to ours) first.
                withContext(thread) {
                    s.onInteraction()
                    assertTrue(s.sendInput("echo a5-\$((6*7))-ok\r"))
                }
                waitFor("the command's output") { withContext(thread) { sink.painted().contains("a5-42-ok") } }
                waitFor("our resize echoed, still ours") {
                    withContext(thread) { s.state.value.mode == TerminalSizing.Mode.Owner && s.state.value.foreignGrid == null }
                }

                api.killLocalTerminal(terminal.id)
                waitFor("the exit frame") { withContext(thread) { s.state.value.dead } }
                assertTrue(withContext(thread) { sink.painted().contains("[process exited") })
            } finally {
                withContext(thread) { stream?.disconnect() }
                scope.cancel()
                thread.close()
                runCatching {
                    if (!LocalPresentation.isDead(api.getLocalTerminal(terminal.id))) api.killLocalTerminal(terminal.id, "SIGKILL")
                    waitFor("dead") { LocalPresentation.isDead(api.getLocalTerminal(terminal.id)) }
                }
                api.deleteLocalTerminal(terminal.id)
            }
        }
}
