package dev.optio.core.ui.gallery

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.LibraryBooks
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.TaskState
import dev.optio.core.testing.Samples
import dev.optio.core.testing.ScreenSize
import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.UsageSamples
import dev.optio.core.testing.captureScreens
import dev.optio.core.ui.components.ChatComposer
import dev.optio.core.ui.components.ChipPicker
import dev.optio.core.ui.components.CodeBlock
import dev.optio.core.ui.components.CopyableText
import dev.optio.core.ui.components.DetailHeader
import dev.optio.core.ui.components.DetailTabs
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.InsightCard
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.MessageBubble
import dev.optio.core.ui.components.MessageRole
import dev.optio.core.ui.components.MeterBar
import dev.optio.core.ui.components.MonoText
import dev.optio.core.ui.components.NoticeBanner
import dev.optio.core.ui.components.OptioGlyph
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.PeriodPicker
import dev.optio.core.ui.components.PipelineStrip
import dev.optio.core.ui.components.RateBar
import dev.optio.core.ui.components.SectionHeader
import dev.optio.core.ui.components.ServerChip
import dev.optio.core.ui.components.ServerDot
import dev.optio.core.ui.components.ServerOption
import dev.optio.core.ui.components.ServerSwitcherChip
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.SkeletonStrip
import dev.optio.core.ui.components.StatItem
import dev.optio.core.ui.components.StatStrip
import dev.optio.core.ui.components.StateDot
import dev.optio.core.ui.components.StatusBadge
import dev.optio.core.ui.components.Truncation
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.components.tinted
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.log.AgentLogView
import dev.optio.core.ui.theme.ChartPalette
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.StatusKind
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.usage.AccountUsagePill
import dev.optio.core.ui.usage.LimitsPanel
import dev.optio.core.ui.usage.LocalUsageStore
import dev.optio.core.ui.usage.UsageTokenBanners
import org.junit.Test

/**
 * The component gallery, light and dark (`./gradlew :core:ui:recordRoborazziDebug`, then open
 * `core/ui/build/outputs/roborazzi/Gallery_*.png`).
 */
class ComponentGalleryTest : ScreenshotTest() {
    @Test
    fun theme() = captureScreens("Gallery_1_Theme", ScreenSize.TALL) {
        Page {
            Caption("Status palette (StatusKind)")
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                StatusKind.entries.forEach { kind -> Swatch(kind.color, kind.label, Modifier.weight(1f)) }
            }
            Caption("Tones: dot · text · badge")
            Tone.entries.forEach { tone ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.m)) {
                    StateDot(tone, pulse = false)
                    Text(tone.name.lowercase(), style = OptioTheme.type.subheadline, color = tone.textColor, modifier = Modifier.width(80.dp))
                    StatusBadge(text = tone.name.lowercase(), tone = tone)
                    Text(if (tone.showsDot) "dot in rows" else "no dot", style = OptioTheme.type.caption, color = OptioTheme.colors.tertiaryLabel)
                }
            }
            Caption("Labels and fills")
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                val c = OptioTheme.colors
                Swatch(c.label, "label", Modifier.weight(1f))
                Swatch(c.secondaryLabel, "secondary", Modifier.weight(1f))
                Swatch(c.tertiaryLabel, "tertiary", Modifier.weight(1f))
                Swatch(c.quaternaryLabel, "quaternary", Modifier.weight(1f))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                val c = OptioTheme.colors
                Swatch(c.fill, "fill", Modifier.weight(1f))
                Swatch(c.fillSecondary, "fill 2", Modifier.weight(1f))
                Swatch(c.fillTertiary, "fill 3", Modifier.weight(1f))
                Swatch(c.card, "card", Modifier.weight(1f))
            }
            Caption("Material scheme")
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                val s = MaterialTheme.colorScheme
                Swatch(s.primary, "primary", Modifier.weight(1f))
                Swatch(s.primaryContainer, "primaryC", Modifier.weight(1f))
                Swatch(s.secondaryContainer, "secondaryC", Modifier.weight(1f))
                Swatch(s.tertiary, "tertiary", Modifier.weight(1f))
                Swatch(s.error, "error", Modifier.weight(1f))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                ChartPalette.series.forEachIndexed { i, color -> Swatch(color, "chart $i", Modifier.weight(1f)) }
            }
            Caption("Type (iOS roles)")
            val t = OptioTheme.type
            TypeSample("Large title", t.largeTitle)
            TypeSample("Title 2 · 42", t.title2)
            TypeSample("Headline", t.headline)
            TypeSample("Body — row title that can wrap", t.body)
            TypeSample("Subheadline — row meta", t.subheadline, OptioTheme.colors.secondaryLabel)
            TypeSample("Footnote — tertiary line", t.footnote, OptioTheme.colors.tertiaryLabel)
            TypeSample("Section header", t.sectionHeader, OptioTheme.colors.secondaryLabel)
            TypeSample("128  $0.78", t.statValue)
            TypeSample("/Users/dev/acme/web · fix/login-race · #519", t.monoFootnote)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.m)) {
                OptioGlyph(size = 28.dp, color = OptioTheme.colors.accent)
                OptioGlyph(size = 20.dp)
                ServerDot(Color(0xFF2F6FED))
                ServerDot(Color(0xFF0F9F9A))
                ServerDot(Color(0xFFD97706))
            }
        }
    }

    @Test
    fun rows() = captureScreens("Gallery_2_Rows", ScreenSize.TALL) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(top = Spacing.l)) {
            SectionHeader("Needs you", detail = "2", tone = Tone.ACCENT, action = {})
            val card = Modifier.padding(horizontal = Spacing.l).fillMaxWidth()
            Column(card.background(OptioTheme.colors.card, Radius.cardShape)) {
                OptioRow(
                    "Fix the flaky login test",
                    tone = Tone.ACCENT,
                    meta = metaText("acme/web", "Claude Code", mono("#519"), "$0.78"),
                    trailing = "2m",
                    onClick = {},
                )
                InsetDivider(start = 31.dp)
                OptioRow(
                    "Upgrade the payments SDK and regenerate the client so the retries stop timing out",
                    tone = Tone.DANGER,
                    meta = metaText("acme/payments", "Codex", mono("main")),
                    footer = metaText("Tests failed: 3 of 212 — checkout.spec.ts"),
                    footerTone = Tone.DANGER,
                    trailing = "Failed",
                    trailingTone = Tone.DANGER,
                    onClick = {},
                )
            }
            SectionHeader("Running", detail = "3")
            Column(card.background(OptioTheme.colors.card, Radius.cardShape)) {
                OptioRow("Migrate the image cache to Coil 3", tone = Tone.WORKING, meta = metaText("acme/mobile", "Claude Code", "12m"), trailing = "now", onClick = {})
                InsetDivider(start = 31.dp)
                OptioRow(
                    "Add a dark mode toggle to Settings",
                    tone = Tone.forState("pr_opened"),
                    meta = metaText("acme/web", mono("#42"), "CI passing"),
                    trailing = Samples.ago(95).relativeDescription(Samples.NOW),
                    onClick = {},
                )
                InsetDivider(start = 31.dp)
                OptioRow(
                    "Paginate the activity feed",
                    tone = Tone.forState("completed"),
                    meta = metaText("acme/web", mono("#44"), tinted("Merged", Tone.SUCCESS.textColor)),
                    trailing = "Merged",
                    trailingTone = Tone.SUCCESS,
                    onClick = {},
                )
                InsetDivider()
                OptioRow("Queued: document the config loader", tone = Tone.forState("queued"), meta = metaText("acme/web", "waits on 1 task"), trailing = "1h", onClick = {})
            }
            GroupedSection(header = "Details", footer = "Settings and detail screens use inset-grouped sections.") {
                KeyValueRow("State", "Running")
                InsetDivider()
                KeyValueRow("Branch", "optio/task-5f1c2a9e-fix-flaky-login", mono = true)
                InsetDivider()
                KeyValueRow("Cost", "$0.42")
                InsetDivider()
                KeyValueRow("Notify me", null, trailing = { Switch(checked = true, onCheckedChange = {}) })
            }
            SectionHeader("Loading")
            SkeletonRows()
        }
    }

    @Test
    fun controls() = captureScreens("Gallery_3_Controls", ScreenSize.TALL) {
        Page {
            Caption("StatStrip (idle zeros, a selected filter, five tiles)")
            StatStrip(listOf(StatItem("Running", 0), StatItem("Queued", 0), StatItem("Needs you", 0, Tone.ACCENT), StatItem("Failed", 0, Tone.DANGER)))
            StatStrip(
                listOf(StatItem("Running", 3), StatItem("Queued", 12), StatItem("Needs you", 2, Tone.ACCENT), StatItem("Failed", 1, Tone.DANGER)),
                selected = "Needs you",
                onSelect = {},
            )
            StatStrip(listOf(StatItem("Running", 3), StatItem("Queued", 1), StatItem("In review", 4), StatItem("Needs you", 2, Tone.ACCENT), StatItem("Failed", 0, Tone.DANGER)))
            SkeletonStrip()
            Caption("ChipPicker · DetailTabs · PeriodPicker")
            ChipPicker(listOf("all" to "All", "queue" to "Queue", "running" to "Running", "ci" to "CI", "review" to "Review", "attention" to "Needs you"), selection = "running", onSelect = {}, contentPadding = PaddingValues())
            DetailTabs(listOf(0 to "Logs", 1 to "Activity", 2 to "Config"), selection = 0, onSelect = {}, contentPadding = PaddingValues())
            PeriodPicker(days = 30, onDaysChange = {})
            Caption("Badges and dots")
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s), verticalAlignment = Alignment.CenterVertically) {
                StatusBadge(state = "running")
                StatusBadge(state = "needs_attention")
                StatusBadge(state = "failed")
                StatusBadge(state = "merged")
                StatusBadge(state = "queued")
            }
            Caption("Server identity")
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s), verticalAlignment = Alignment.CenterVertically) {
                ServerChip("mbp", Color(0xFF2F6FED))
                ServerChip("studio", Color(0xFF0F9F9A), prominent = true)
                ServerChip("cloud", Color(0xFFE11D48), prominent = true, switching = true)
                val a = ServerOption("a", "mbp", "jons-mbp.tail1234.ts.net", Color(0xFF2F6FED))
                ServerSwitcherChip(active = a, servers = listOf(a), onSwitch = {}, onAddServer = {}, onManageServers = {})
            }
            Caption("InsightCard · RateBar · MeterBar · PipelineStrip")
            InsightCard("Success rate by repo", trailing = { Text("30d", style = OptioTheme.type.caption, color = OptioTheme.colors.tertiaryLabel) }) {
                RateBar("acme/web", "92%", 0.92)
                RateBar("acme/mobile", "71%", 0.71, color = ChartPalette.color(0))
                RateBar("acme/payments", "38%", 0.38)
            }
            MeterBar(0.64, color = Tone.WORKING.color)
            PipelineStrip(listOf("Queue", "Setup", "Running", "CI", "Review", "Merged"), current = 3)
            PipelineStrip(listOf("Queue", "Setup", "Running", "CI", "Review", "Merged"), current = 2, failed = true)
        }
    }

    @Test
    fun states() = captureScreens("Gallery_4_States", ScreenSize.TALL) {
        Page {
            Caption("EmptyState")
            Box(Modifier.fillMaxWidth().background(OptioTheme.colors.card, Radius.cardShape)) {
                EmptyState(
                    "No running work",
                    icon = Icons.Outlined.Schedule,
                    message = "Start something from New work, or wait for a schedule to fire.",
                    actionTitle = "New work",
                    action = {},
                )
            }
            Caption("ErrorRow")
            ErrorRow(dev.optio.core.network.ApiError(429, "Too Many Requests"), retry = {}, contentPadding = PaddingValues())
            ErrorRow(dev.optio.core.network.ApiError(0, "Decoding TasksPage failed"), what = "tasks", retry = {}, contentPadding = PaddingValues())
            Caption("NoticeBanner")
            NoticeBanner(tone = Tone.ACCENT, icon = Icons.Outlined.Schedule, title = "Plan ready for review") {
                Text("Check the agent output, then send feedback or approve.")
            }
            NoticeBanner(tone = Tone.DANGER) { Text("The pod was OOM-killed at 2.1 Gi. Raise the memory limit in the repo settings.") }
            NoticeBanner(tone = Tone.SUCCESS) { Text("Awaited the session cookie before navigating; 20/20 runs pass.") }
            Caption("Mono, copyable, code")
            MonoText("/Users/dev/acme/web/packages/mobile/src/screens/settings", truncation = Truncation.HEAD)
            CopyableText("5f1c2a9e-8d7b-4c3e-9a1f-2b6d8e4c7a10")
            CodeBlock("{\n  \"repo\": \"acme/web\",\n  \"schedule\": \"0 9 * * 1\"\n}")
            Caption("Buttons")
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                androidx.compose.material3.Button(onClick = {}) { Text("Run now") }
                androidx.compose.material3.FilledTonalButton(onClick = {}) { Text("Retry") }
                OutlinedButton(onClick = {}) { Text("Cancel") }
                TextButton(onClick = {}) { Text("Open") }
            }
        }
    }

    @Test
    fun detail() = captureScreens("Gallery_5_Detail") {
        CompositionLocalProvider(LocalUsageStore provides UsageSamples.store()) {
            Column(Modifier.fillMaxSize()) {
                val task = Samples.task(state = TaskState.RUNNING)
                DetailHeader(
                    state = task.state.raw,
                    line = metaText("started 40 min. ago", "Sonnet", "Claude Code", "$0.42"),
                    secondary = metaText("acme/web", mono("optio/task-5f1c-fix-login"), mono("#42")),
                    showsUsage = true,
                ) {
                    IconButton(onClick = {}) { Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = "Open pull request") }
                }
                DetailHeader(
                    state = "needs_attention",
                    line = metaText("12m 4s", "Opus"),
                    secondary = metaText(mono("/Users/dev/acme/web")),
                    needsYou = "Merge conflict — resume?",
                )
                DetailHeader(state = "failed", line = metaText("exit 2", "$0.02"), secondary = metaText("Tests failed: 3 of 212"))
                Column(
                    Modifier.weight(1f).fillMaxWidth().padding(Spacing.l),
                    verticalArrangement = Arrangement.spacedBy(Spacing.m),
                ) {
                    MessageBubble(MessageRole.USER, "Can you also update the changelog?", meta = "4:02 PM")
                    MessageBubble(MessageRole.AGENT, "Done — added an entry under **Unreleased** and linked `#42`.", meta = "4:03 PM · $0.01")
                    MessageBubble(MessageRole.SYSTEM, "Turn 12 finished · natural halt")
                    MessageBubble(MessageRole.USER, "Ship it", meta = "Sending…", pending = true)
                }
                ChatComposer(onSend = {}, placeholder = "Message Release Captain")
            }
        }
    }

    @Test
    fun agentLog() = captureScreens(
        "Gallery_6_AgentLog",
        interact = {
            onNode(hasTestTag("log-row-3")).performClick()
            waitForIdle()
        },
    ) {
        AgentLogView(Samples.transcript(), autoScroll = false)
    }

    @Test
    fun agentLogFromRecordedTranscript() = captureScreens("Gallery_7_AgentLogRecorded", ScreenSize.TALL) {
        AgentLogView(RecordedTranscript.entries(), autoScroll = false)
    }

    @Test
    fun usage() = captureScreens("Gallery_8_Usage", ScreenSize.TALL) {
        val store = UsageSamples.store(refreshed = true)
        CompositionLocalProvider(LocalUsageStore provides store) {
            Page {
                Caption("LimitsPanel (Claude live + Codex snapshot)")
                LimitsPanel()
                Caption("AccountUsagePill: normal · elevated · stale")
                AccountUsagePill()
                AccountUsagePill(store = UsageSamples.store(UsageSamples.usage(fiveHour = 83.0, sevenDay = 97.0, models = emptyList())))
                AccountUsagePill(store = UsageSamples.store(UsageSamples.usage(stale = true)))
                Caption("UsageTokenBanners (both tokens failing)")
                UsageTokenBanners(store = UsageSamples.store(UsageSamples.expired(), hosts = emptyList()))
            }
        }
    }

    @Test
    fun usageBreakdown() = captureScreens(
        "Gallery_9_UsageBreakdown",
        wholeScreen = true,
        interact = {
            onNode(hasTestTag("usage-pill")).performClick()
            waitForIdle()
        },
    ) {
        CompositionLocalProvider(LocalUsageStore provides UsageSamples.store(UsageSamples.usage(stale = true))) {
            Column(Modifier.fillMaxSize().statusBarsPadding().padding(Spacing.l)) { AccountUsagePill() }
        }
    }

    @Test
    fun chrome() = captureScreens("Gallery_10_Chrome") {
        CompositionLocalProvider(LocalUsageStore provides UsageSamples.store()) {
            Scaffold(
                topBar = {
                    Column {
                        TopAppBar(
                            title = { Text("Work") },
                            navigationIcon = {
                                val a = ServerOption("a", "mbp", "jons-mbp.tail1234.ts.net", Color(0xFF2F6FED))
                                val b = ServerOption("b", "studio", "studio.tail1234.ts.net", Color(0xFF0F9F9A))
                                ServerSwitcherChip(active = a, servers = listOf(a, b), onSwitch = {}, onAddServer = {}, onManageServers = {}, modifier = Modifier.padding(start = Spacing.s))
                            },
                            actions = {
                                IconButton(onClick = {}) { Icon(Icons.Outlined.Search, contentDescription = "Search") }
                                IconButton(onClick = {}) { Icon(Icons.Outlined.Refresh, contentDescription = "Refresh") }
                            },
                        )
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 8.dp)) {
                            listOf("All", "Reviews", "Inbox").forEachIndexed { i, label ->
                                SegmentedButton(selected = i == 0, onClick = {}, shape = SegmentedButtonDefaults.itemShape(i, 3), icon = {}, label = { Text(label) })
                            }
                        }
                    }
                },
                bottomBar = {
                    NavigationBar {
                        listOf(
                            Icons.Outlined.Dashboard to "Overview",
                            Icons.Outlined.Hub to "Work",
                            Icons.Outlined.LibraryBooks to "Library",
                            Icons.Outlined.BarChart to "Insights",
                            Icons.Outlined.MoreHoriz to "More",
                        ).forEachIndexed { i, (icon, label) ->
                            NavigationBarItem(selected = i == 1, onClick = {}, icon = { Icon(icon, contentDescription = null) }, label = { Text(label) })
                        }
                    }
                },
                floatingActionButton = {
                    ExtendedFloatingActionButton(onClick = {}, icon = { Icon(Icons.Outlined.Add, contentDescription = null) }, text = { Text("New") })
                },
            ) { padding ->
                Column(Modifier.padding(padding).fillMaxSize()) {
                    ChipPicker(listOf("active" to "Active", "recurring" to "Recurring", "agents" to "Agents", "history" to "History"), selection = "active", onSelect = {})
                    StatStrip(
                        listOf(StatItem("Running", 3), StatItem("Waiting", 1), StatItem("Needs you", 2, Tone.ACCENT), StatItem("Failed", 0, Tone.DANGER)),
                        modifier = Modifier.padding(horizontal = Spacing.l),
                    )
                    SectionHeader("Needs you", detail = "2", tone = Tone.ACCENT)
                    OptioRow("Fix the flaky login test", tone = Tone.ACCENT, meta = metaText("mbp", mono("~/acme/web"), "Allow?"), trailing = "2m", onClick = {})
                    InsetDivider(start = 31.dp)
                    OptioRow("Review: add a dark mode toggle", tone = Tone.ACCENT, meta = metaText("acme/web", mono("#42"), "changes requested"), trailing = "14m", onClick = {})
                    SectionHeader("Running", detail = "3")
                    OptioRow("Migrate the image cache to Coil 3", tone = Tone.WORKING, meta = metaText("acme/mobile", "Claude Code"), trailing = "now", onClick = {})
                }
            }
        }
    }

    // region helpers

    @Composable
    private fun Page(content: @Composable ColumnScope.() -> Unit) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).statusBarsPadding().padding(Spacing.l),
            verticalArrangement = Arrangement.spacedBy(Spacing.m),
            content = content,
        )
    }

    @Composable
    private fun Caption(text: String) {
        Text(text, style = OptioTheme.type.sectionHeader, color = OptioTheme.colors.secondaryLabel, modifier = Modifier.padding(top = Spacing.s))
    }

    @Composable
    private fun Swatch(color: Color, label: String, modifier: Modifier = Modifier) {
        Column(modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Box(Modifier.fillMaxWidth().height(32.dp).background(color, Radius.smallShape))
            Text(label, style = OptioTheme.type.caption2, color = OptioTheme.colors.secondaryLabel, maxLines = 1)
        }
    }

    @Composable
    private fun TypeSample(text: String, style: TextStyle, color: Color = OptioTheme.colors.label) {
        Text(text, style = style, color = color, maxLines = 1)
    }

    // endregion
}

/** The recorded Claude Code transcript fixture, grouped like iOS `LocalTranscriptLog`. */
internal object RecordedTranscript {
    @kotlinx.serialization.Serializable
    private data class Envelope(val entries: List<dev.optio.core.model.LocalTranscriptEntry>)

    fun entries(): List<AgentLogEntry> {
        val transcript = dev.optio.core.testing.Fixtures.decode<Envelope>("local-transcript.json").entries
        val results = transcript.filter { it.kind == dev.optio.core.model.LocalTranscriptKind.TOOL_RESULT }.associateBy { it.toolUseId }
        val claimed = transcript.filter { it.kind == dev.optio.core.model.LocalTranscriptKind.TOOL_USE }.mapNotNull { results[it.toolUseId]?.seq }.toSet()
        fun str(s: String) = kotlinx.serialization.json.JsonPrimitive(s)
        return transcript.mapNotNull { e ->
            val at = e.at.orEmpty()
            when (e.kind) {
                dev.optio.core.model.LocalTranscriptKind.TOOL_USE -> {
                    val result = results[e.toolUseId]
                    val meta = buildMap {
                        put("summary", str(e.text))
                        e.toolName?.let { put("toolName", str(it)) }
                        if (result != null) {
                            put("result", str(result.text))
                            put("resultIsError", kotlinx.serialization.json.JsonPrimitive(result.isError))
                        }
                    }
                    AgentLogEntry("t", at, type = AgentLogEntry.TypeValue.TOOL_USE, content = e.detail.orEmpty(), metadata = meta)
                }
                dev.optio.core.model.LocalTranscriptKind.TOOL_RESULT ->
                    if (e.seq in claimed) null else AgentLogEntry("t", at, type = AgentLogEntry.TypeValue.TOOL_RESULT, content = e.text)
                dev.optio.core.model.LocalTranscriptKind.THINKING -> AgentLogEntry("t", at, type = AgentLogEntry.TypeValue.THINKING, content = e.text)
                else -> AgentLogEntry(
                    "t",
                    at,
                    type = AgentLogEntry.TypeValue.TEXT,
                    content = e.text,
                    metadata = if (e.role == dev.optio.core.model.LocalTranscriptRole.USER) mapOf("role" to str("user")) else null,
                )
            }
        }
    }
}
