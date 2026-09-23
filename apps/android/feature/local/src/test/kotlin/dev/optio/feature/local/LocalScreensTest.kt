package dev.optio.feature.local

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import dev.optio.core.model.LocalAgentKind
import dev.optio.core.model.LocalAgentSessionMode
import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalBlueprint
import dev.optio.core.model.LocalBlueprintSpawnMode
import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalHostDir
import dev.optio.core.model.LocalHostState
import dev.optio.core.model.LocalSpawnSource
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.LocalTerminalPendingReason
import dev.optio.core.model.LocalTerminalSpec
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.model.OptioJson
import dev.optio.core.model.WorkLink
import dev.optio.core.model.WorkLinkKind
import dev.optio.core.model.WorkLinkProvider
import dev.optio.core.terminal.TerminalGrid
import dev.optio.core.terminal.TerminalGridMode
import dev.optio.core.terminal.TerminalSamples
import dev.optio.core.terminal.TerminalSizing
import dev.optio.core.terminal.TerminalState
import dev.optio.core.testing.Fixtures
import dev.optio.core.testing.Samples
import dev.optio.core.testing.ScreenSize
import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.UsageSamples
import dev.optio.core.testing.captureScreens
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.usage.LocalUsageStore
import dev.optio.feature.local.api.LocalTranscriptPage
import dev.optio.feature.local.api.LocalTrigger
import dev.optio.feature.local.automations.AutomationContent
import dev.optio.feature.local.automations.AutomationForm
import dev.optio.feature.local.automations.AutomationFormContent
import dev.optio.feature.local.automations.AutomationFormViewModel
import dev.optio.feature.local.automations.AutomationPage
import dev.optio.feature.local.machines.HostPage
import dev.optio.feature.local.machines.LocalHostContent
import dev.optio.feature.local.model.LocalSessionView
import dev.optio.feature.local.stream.LocalTerminalStream
import dev.optio.feature.local.terminal.LocalTerminalScaffold
import dev.optio.feature.local.terminal.TerminalActions
import dev.optio.feature.local.transcript.LocalTranscriptModel
import java.time.Duration
import org.junit.Test

/**
 * Roborazzi screenshots of `:feature:local`, light and dark:
 * `./gradlew :feature:local:recordRoborazziDebug` → `feature/local/build/outputs/roborazzi/`.
 */
class LocalScreensTest : ScreenshotTest() {
    // region Samples (the DevLab seed's "E2E laptop" and its recorded agent session)

    private val laptop =
        Samples.localHost(
            id = "host-laptop",
            name = "E2E laptop",
            hostname = "e2e-laptop",
            state = LocalHostState.OFFLINE,
            dirs = listOf(LocalHostDir("/Users/e2e/repos/e2e-repo", "https://github.com/e2e-org/e2e-repo"), LocalHostDir("/Users/e2e/notes")),
            lastSeenAt = Samples.agoIso(42),
        )
    private val mbp = Samples.localHost(codex = null)

    private val transcript = Fixtures.decode<LocalTranscriptPage>("local-transcript.json").entries

    private val recorded =
        Samples.localTerminal(
            id = "term-recorded",
            hostId = laptop.id,
            title = "Fix the flaky date-formatting test",
            dir = "/Users/e2e/repos/e2e-repo",
            state = LocalTerminalState.EXITED,
            attentionState = LocalAttentionState.NEEDS_YOU,
            attentionReason = "exit",
            exitCode = 0,
            spawnedBy = LocalSpawnSource.BLUEPRINT,
            links = listOf(WorkLink("https://github.com/e2e-org/e2e-repo/pull/412", WorkLinkKind.PR, WorkLinkProvider.GITHUB, "e2e-org/e2e-repo#412")),
        ).copy(agentSessionId = "sess-7f3c", endedAt = Samples.agoIso(3))

    private val liveAgent =
        Samples.localTerminal(
            attentionState = LocalAttentionState.WORKING,
            attentionReason = null,
            links = emptyList(),
        )

    private val shell =
        Samples.localTerminal(
            id = "term-shell",
            title = "shell",
            dir = "/Users/dev/scratch",
            spec = LocalTerminalSpec.Shell,
            attentionState = LocalAttentionState.WORKING,
            attentionReason = null,
            links = emptyList(),
            costUsd = null,
        ).copy(command = "zsh")

    // endregion

    @Composable
    private fun WithUsage(content: @Composable () -> Unit) {
        val store = remember { UsageSamples.store() }
        CompositionLocalProvider(LocalUsageStore provides store, content = content)
    }

    @Composable
    private fun Terminal(
        terminal: LocalTerminal,
        view: LocalSessionView?,
        stream: LocalTerminalStream.State = LocalTerminalStream.State(conn = LocalTerminalStream.ConnState.CONNECTED, outputSeen = true),
        entries: List<dev.optio.core.model.LocalTranscriptEntry> = emptyList(),
        screen: () -> TerminalState = { TerminalState() },
        focusComposer: Boolean = false,
        hosts: List<LocalHost> = listOf(mbp),
    ) {
        WithUsage {
            val state = remember { screen() }
            LocalTerminalScaffold(
                loadState = LoadState.Loaded(terminal),
                hosts = hosts,
                view = view,
                transcript = LocalTranscriptModel.State(entries, loaded = true),
                stream = stream,
                screen = state,
                busy = false,
                canMutate = true,
                focusComposer = focusComposer,
                snoozedUntil = null,
                actions = TerminalActions(),
            )
        }
    }

    // region Terminal: Transcript face

    @Test
    fun transcriptOfTheRecordedSession() =
        captureScreens("LocalTerminal_Transcript_recorded") {
            Terminal(recorded, LocalSessionView.TRANSCRIPT, entries = transcript, hosts = listOf(mbp, laptop))
        }

    @Test
    fun transcriptOfALiveSessionWithTheComposer() =
        captureScreens("LocalTerminal_Transcript_live") {
            Terminal(liveAgent, LocalSessionView.TRANSCRIPT, entries = transcript.take(7))
        }

    @Test
    fun transcriptWaitingOnYou() =
        captureScreens("LocalTerminal_Transcript_needsYou") {
            Terminal(
                liveAgent.copy(attentionState = LocalAttentionState.NEEDS_YOU, attentionReason = "stop"),
                LocalSessionView.TRANSCRIPT,
                entries = transcript,
            )
        }

    @Test
    fun transcriptNotYetStarted() =
        captureScreens("LocalTerminal_Transcript_empty") {
            Terminal(liveAgent.copy(links = emptyList()), LocalSessionView.TRANSCRIPT, entries = emptyList())
        }

    // endregion

    // region Terminal: Screen face

    @Test
    fun screenSizedForAnotherDevice() =
        captureScreens("LocalTerminal_Screen_passive") {
            Terminal(
                liveAgent,
                LocalSessionView.SCREEN,
                stream =
                    LocalTerminalStream.State(
                        conn = LocalTerminalStream.ConnState.CONNECTED,
                        outputSeen = true,
                        mode = TerminalSizing.Mode.Passive(TerminalGrid(160, 45)),
                    ),
                entries = transcript,
                screen = { TerminalState(TerminalGridMode.Fixed(160, 45)).also { it.feed(TerminalSamples.claudeCode(160, 45)) } },
            )
        }

    @Test
    fun screenClaimedByThePhone() =
        captureScreens("LocalTerminal_Screen_owner") {
            Terminal(
                shell,
                LocalSessionView.SCREEN,
                stream = LocalTerminalStream.State(conn = LocalTerminalStream.ConnState.CONNECTED, outputSeen = true, mode = TerminalSizing.Mode.Owner),
                screen = { TerminalState().also { it.feed(TerminalSamples.shell(60)) } },
            )
        }

    @Test
    fun screenRecordedAtExit() =
        captureScreens("LocalTerminal_Screen_recorded") {
            Terminal(
                recorded,
                LocalSessionView.SCREEN,
                stream =
                    LocalTerminalStream.State(
                        conn = LocalTerminalStream.ConnState.CONNECTED,
                        outputSeen = true,
                        settled = true,
                        dead = true,
                        recorded = true,
                        exitCode = 0,
                        mode = TerminalSizing.Mode.Passive(TerminalGrid(132, 40)),
                    ),
                entries = transcript,
                screen = {
                    TerminalState(TerminalGridMode.Fixed(132, 40)).also {
                        it.feed(TerminalSamples.claudeCode(132, 40))
                        it.feed("\r\n\u001b[2m[process exited (code 0)]\u001b[0m\r\n")
                    }
                },
            )
        }

    @Test
    fun screenHostOfflineRetrying() =
        captureScreens("LocalTerminal_Screen_hostOffline") {
            Terminal(
                shell,
                LocalSessionView.SCREEN,
                stream =
                    LocalTerminalStream.State(
                        conn = LocalTerminalStream.ConnState.RECONNECTING,
                        errorMessage = "Host is offline",
                        retrying = true,
                        outputSeen = true,
                    ),
                screen = { TerminalState().also { it.feed(TerminalSamples.shell(30)) } },
            )
        }

    @Test
    fun screenLastOutputOfAnOldRow() =
        captureScreens("LocalTerminal_Screen_lastOutput") {
            Terminal(
                shell.copy(
                    state = LocalTerminalState.EXITED,
                    exitCode = 2.0,
                    attentionState = LocalAttentionState.IDLE,
                    title = "npm run build",
                    preview = "> build\n> tsc -p .\n\nsrc/index.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n\nFound 1 error.",
                ),
                LocalSessionView.SCREEN,
                stream =
                    LocalTerminalStream.State(
                        conn = LocalTerminalStream.ConnState.DISCONNECTED,
                        settled = true,
                        dead = true,
                    ),
            )
        }

    @Test
    fun heldTerminalHeader() =
        captureScreens("LocalTerminal_held") {
            Terminal(
                shell.copy(state = LocalTerminalState.PENDING, pendingReason = LocalTerminalPendingReason.HOLD, attentionState = LocalAttentionState.IDLE, title = "Nightly triage"),
                LocalSessionView.SCREEN,
                stream = LocalTerminalStream.State(conn = LocalTerminalStream.ConnState.CONNECTED),
            )
        }

    @Test
    fun terminalMenu() =
        captureScreens("LocalTerminal_menu", wholeScreen = true, modes = listOf(dev.optio.core.testing.ThemeMode.LIGHT), interact = {
            onNodeWithTag("terminal-menu").performClick()
        }) {
            Terminal(recorded, LocalSessionView.TRANSCRIPT, entries = transcript)
        }

    @Test
    fun killDialog() =
        captureScreens("LocalTerminal_kill", wholeScreen = true, modes = listOf(dev.optio.core.testing.ThemeMode.DARK), interact = {
            onNodeWithTag("terminal-menu").performClick()
            onNodeWithTag("menu-kill").performClick()
        }) {
            Terminal(liveAgent, LocalSessionView.TRANSCRIPT, entries = transcript.take(4))
        }

    // endregion

    // region Machines

    private val automation =
        Samples.localBlueprint().copy(hostId = mbp.id)
    private val prReview =
        LocalBlueprint(
            id = "bp-review",
            name = "Review PRs I'm tagged on",
            commandTemplate = "I was asked to review {{url}} ({{repo}} #{{number}}: {{title}}).",
            agent = LocalAgentKind.CLAUDE_CODE,
            spawnMode = LocalBlueprintSpawnMode.AUTO,
            sessionMode = LocalAgentSessionMode.HEADLESS,
            enabled = true,
            createdAt = Samples.agoIso(60 * 24 * 3),
            updatedAt = Samples.agoIso(60 * 24),
        )
    private val paused = Samples.localBlueprint(id = "bp-shell", name = "Rotate logs", agent = null, enabled = false).copy(commandTemplate = "logrotate ./logrotate.conf", dir = "/Users/dev/scratch")

    private fun trigger(
        id: String,
        type: String,
        config: String,
        enabled: Boolean = true,
        next: Long? = null,
        last: Long? = null,
    ) = LocalTrigger(
        id = id,
        type = type,
        config = OptioJson.parseToJsonElement(config) as kotlinx.serialization.json.JsonObject,
        enabled = enabled,
        nextFireAt = next?.let { Samples.NOW.plus(Duration.ofMinutes(it)) },
        lastFiredAt = last?.let { Samples.ago(it) },
    )

    private val triggers =
        mapOf(
            automation.id to listOf(trigger("t1", "schedule", """{"cronExpression":"0 9 * * 1-5"}""", next = 16 * 60)),
            prReview.id to listOf(trigger("t2", "github", """{"events":["review_requested","mentioned"],"login":"octo"}""", last = 180)),
            paused.id to listOf(trigger("t3", "webhook", """{"path":"rotate-logs"}""", enabled = false)),
        )

    @Test
    fun machines() =
        captureScreens("Machines", size = ScreenSize.TALL) {
            MachinesContent(
                hosts = LoadState.Loaded(listOf(mbp, laptop)),
                automations = LoadState.Loaded(listOf(automation, prReview, paused)),
                triggers = triggers,
                canMutate = true,
                contentPadding = PaddingValues(),
            )
        }

    @Test
    fun machinesEmpty() =
        captureScreens("Machines_empty") {
            MachinesContent(
                hosts = LoadState.Loaded(emptyList()),
                automations = LoadState.Loaded(emptyList()),
                triggers = emptyMap(),
                canMutate = true,
                contentPadding = PaddingValues(),
            )
        }

    @Test
    fun machineLoadFailed() =
        captureScreens("Machines_error", modes = listOf(dev.optio.core.testing.ThemeMode.LIGHT)) {
            MachinesContent(
                hosts = LoadState.Failed(java.io.IOException("offline")),
                automations = LoadState.Loading(),
                triggers = emptyMap(),
                canMutate = true,
                contentPadding = PaddingValues(),
            )
        }

    @Test
    fun machinePage() =
        captureScreens("LocalHost", size = ScreenSize.TALL) {
            LocalHostContent(
                page =
                    LoadState.Loaded(
                        HostPage(
                            host = mbp,
                            terminals =
                                listOf(
                                    Samples.localTerminal(id = "n1"),
                                    Samples.localTerminal(id = "w1", title = "Upgrade React to 19", attentionState = LocalAttentionState.WORKING, links = emptyList()),
                                    shell,
                                    Samples.localTerminal(
                                        id = "p1",
                                        title = "Nightly triage",
                                        state = LocalTerminalState.PENDING,
                                        attentionState = LocalAttentionState.IDLE,
                                    ).copy(pendingReason = LocalTerminalPendingReason.HOLD),
                                    recorded.copy(hostId = mbp.id),
                                    shell.copy(id = "e2", title = "npm run build", state = LocalTerminalState.EXITED, exitCode = 2.0, attentionState = LocalAttentionState.IDLE, lastActivityAt = Samples.agoIso(300)),
                                ),
                            automations = listOf(automation),
                        ),
                    ),
                canMutate = true,
            )
        }

    // endregion

    // region Automations

    private val automationPage =
        AutomationPage(
            automation = automation,
            triggers = triggers.getValue(automation.id) + trigger("t4", "slack", """{"channelId":"C0123ABCD","keyword":"flaky"}"""),
            runs =
                listOf(
                    Samples.localTerminal(id = "r1", title = "Fix flaky tests", spawnedBy = LocalSpawnSource.TRIGGER, attentionState = LocalAttentionState.NEEDS_YOU),
                    recorded.copy(id = "r2", title = "Fix flaky tests", createdAt = Samples.agoIso(60 * 24)),
                ),
            hosts = listOf(mbp, laptop),
        )

    @Test
    fun automationDetail() =
        captureScreens("Automation", size = ScreenSize.TALL) {
            AutomationContent(page = LoadState.Loaded(automationPage), busy = false, canMutate = true, serverUrl = "http://laptop.tail1234.ts.net:30400")
        }

    @Test
    fun automationDetailWithNothingYet() =
        captureScreens("Automation_new", modes = listOf(dev.optio.core.testing.ThemeMode.LIGHT)) {
            AutomationContent(
                page = LoadState.Loaded(AutomationPage(paused, emptyList(), emptyList(), listOf(mbp))),
                busy = false,
                canMutate = true,
                serverUrl = null,
            )
        }

    @Test
    fun addTriggerSheet() =
        captureScreens("Automation_addTrigger", wholeScreen = true, interact = {
            onNodeWithTag("add-trigger").performClick()
            onNodeWithTag("trigger-kind-github").performClick()
        }) {
            AutomationContent(page = LoadState.Loaded(automationPage), busy = false, canMutate = true, serverUrl = "http://laptop.tail1234.ts.net:30400")
        }

    @Test
    fun newAutomationForm() =
        captureScreens("AutomationForm_new", size = ScreenSize.TALL) {
            AutomationFormContent(
                editing = false,
                loaded = LoadState.Loaded(AutomationFormViewModel.Loaded(listOf(mbp, laptop), null)),
                form = AutomationForm(hostId = mbp.id, dir = "/Users/dev/acme/web", name = "Triage new issues", commandTemplate = "Triage {{ticketTitle}} and label it."),
                saving = false,
                error = null,
                onChange = {},
                onSave = {},
                onRetry = {},
                onBack = {},
            )
        }

    @Test
    fun editShellAutomationForm() =
        captureScreens("AutomationForm_edit", modes = listOf(dev.optio.core.testing.ThemeMode.DARK)) {
            AutomationFormContent(
                editing = true,
                loaded = LoadState.Loaded(AutomationFormViewModel.Loaded(listOf(mbp), paused)),
                form = AutomationForm.from(paused).copy(location = AutomationForm.Location.EVENT),
                saving = false,
                error = "Host not found",
                onChange = {},
                onSave = {},
                onRetry = {},
                onBack = {},
            )
        }

    // endregion
}
