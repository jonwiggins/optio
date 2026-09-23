package dev.optio.feature.local.terminal

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.OpenInFull
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.LocalTerminalPendingReason
import dev.optio.core.model.LocalTerminalSpec
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.model.LocalTranscriptEntry
import dev.optio.core.terminal.TerminalInputMode
import dev.optio.core.terminal.TerminalKeyBar
import dev.optio.core.terminal.TerminalState
import dev.optio.core.terminal.TerminalSurface
import dev.optio.core.terminal.TerminalTheme
import dev.optio.core.ui.components.ChatComposer
import dev.optio.core.ui.components.DetailHeader
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.StateDot
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.format.Cost
import dev.optio.core.ui.format.capitalizedFirst
import dev.optio.core.ui.log.AgentLogView
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.medium
import dev.optio.core.ui.theme.semibold
import dev.optio.feature.local.model.LocalPresentation
import dev.optio.feature.local.model.LocalSessionView
import dev.optio.feature.local.stream.LocalTerminalStream
import dev.optio.feature.local.transcript.LocalTranscriptLog
import dev.optio.feature.local.ui.WorkLinkBadges
import dev.optio.feature.local.ui.optioIsDark
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlin.math.max
import kotlin.math.roundToInt

// region Header

/**
 * The terminal's header (iOS `LocalTerminalScreen.header`): state badge and a `·`-joined line
 * (host, exit code, "starts when the host reconnects", cost), the directory (or the error of a dead
 * terminal), the needs-you row, the Claude usage pill, and, when there is a conversation, the
 * Transcript ⇄ Screen toggle; then the PR / ticket badges in a strip of their own, as the web lays
 * them out on a phone (iOS squeezes them into the badge row).
 */
@Composable
internal fun TerminalHeader(
    terminal: LocalTerminal,
    hosts: List<LocalHost>,
    view: LocalSessionView?,
    hasTranscript: Boolean,
    snoozedUntil: Instant?,
    onChooseView: (LocalSessionView) -> Unit,
    onOpenLink: (String) -> Unit,
    modifier: Modifier = Modifier,
    zone: ZoneId = ZoneId.systemDefault(),
) {
    val t = terminal
    val needsYou = LocalPresentation.waitsOnYou(t)
    val hostName = if (hosts.size > 1) hosts.firstOrNull { it.id == t.hostId }?.name else null
    val links = LocalPresentation.workLinks(t)
    val line =
        metaText(
            hostName,
            if (t.state == LocalTerminalState.EXITED) t.exitCode?.let { "exit ${it.toInt()}" } else null,
            if (t.state == LocalTerminalState.PENDING && t.pendingReason == LocalTerminalPendingReason.HOST_OFFLINE) "starts when the host reconnects" else null,
            Cost.formatIfNonZero(t.costUsd),
        )
    val secondary: AnnotatedString =
        if (LocalPresentation.isDead(t) && !t.errorMessage.isNullOrEmpty()) AnnotatedString(t.errorMessage!!) else mono(t.dir)
    val stateTone = LocalPresentation.stateTone(t)
    val showToggle = hasTranscript && view != null
    val waiting =
        if (needsYou) {
            val label = LocalPresentation.waitingLabel(t).capitalizedFirst()
            snoozedUntil?.let { "$label · later, until ${SHORT_TIME.format(it.atZone(zone))}" } ?: label
        } else {
            snoozedUntil?.let { "Snoozed until ${SHORT_TIME.format(it.atZone(zone))}" }
        }
    Column(modifier) {
        DetailHeader(
            state = LocalPresentation.stateLabel(t),
            tone = if (stateTone == Tone.ACCENT) Tone.WORKING else stateTone,
            line = line,
            secondary = secondary,
            needsYou = waiting,
            showsUsage = true,
        ) {
            if (showToggle) SessionViewToggle(view ?: LocalSessionView.TRANSCRIPT, onChooseView)
        }
        // The web's phone layout: the PR / ticket badges get their own strip under the header.
        if (links.isNotEmpty()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surfaceContainerLow)
                    .padding(horizontal = Spacing.l, vertical = 6.dp)
                    .testTag("work-links"),
            ) {
                WorkLinkBadges(links, onOpen = onOpenLink, max = 4)
            }
            HorizontalDivider(thickness = 0.5.dp, color = OptioTheme.colors.separator)
        }
    }
}

private val SHORT_TIME: DateTimeFormatter = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)

/**
 * Transcript ⇄ Screen (iOS `SessionViewToggle`, web `session-view-toggle.tsx`): two small icon
 * segments in one capsule, the chosen one raised and tinted.
 */
@Composable
internal fun SessionViewToggle(
    view: LocalSessionView,
    onChange: (LocalSessionView) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    Row(
        modifier
            .background(colors.fillTertiary, Radius.capsuleShape)
            .padding(2.dp)
            .selectableGroup()
            .testTag("face-toggle"),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        LocalSessionView.entries.forEach { face ->
            val selected = view == face
            Box(
                Modifier
                    .size(width = 38.dp, height = 28.dp)
                    .background(if (selected) colors.card else Color.Transparent, Radius.capsuleShape)
                    .selectable(selected = selected, role = Role.Tab, onClick = { onChange(face) })
                    .testTag("face-${face.name.lowercase()}"),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (face == LocalSessionView.TRANSCRIPT) Icons.Outlined.ChatBubbleOutline else Icons.Outlined.Terminal,
                    contentDescription = face.label,
                    tint = if (selected) colors.accent else colors.secondaryLabel,
                    modifier = Modifier.size(17.dp),
                )
            }
        }
    }
}

// endregion

// region Transcript face

/**
 * The Transcript face (iOS `LocalTranscriptFace`, web `transcript-view.tsx` + a composer): the
 * agent's conversation reflowed for the phone, "Session in progress" while it runs, and a composer
 * that writes your message plus Enter to the PTY.
 */
@Composable
internal fun TranscriptFace(
    terminal: LocalTerminal,
    entries: List<LocalTranscriptEntry>,
    canSend: Boolean,
    autofocus: Boolean,
    onSend: suspend (String) -> Unit,
    onComposerFocused: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val live = !LocalPresentation.isDead(terminal)
    val log: List<AgentLogEntry> = remember(entries) { LocalTranscriptLog.entries(entries, terminal.id) }
    LaunchedEffect(autofocus) { if (autofocus) onComposerFocused() }
    Column(modifier.fillMaxSize().background(OptioTheme.colors.page).keyboardPadding().testTag("transcript-face")) {
        if (log.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                EmptyState(
                    title = if (live) "Nothing yet" else "No conversation recorded",
                    icon = Icons.Outlined.ChatBubbleOutline,
                    message = if (live) "The conversation shows up here as the agent works." else "Switch to Screen to see the terminal as it ran.",
                )
            }
        } else {
            AgentLogView(log, modifier = Modifier.weight(1f))
        }
        if (live && log.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.l).padding(bottom = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StateDot(Tone.WORKING, size = 6.dp, pulse = false)
                Text("Session in progress", style = OptioTheme.type.caption2, color = OptioTheme.colors.secondaryLabel)
            }
        }
        if (canSend) {
            if (terminal.attentionState == LocalAttentionState.WORKING) {
                val who = (terminal.spec as? LocalTerminalSpec.Agent)?.agent?.let(LocalPresentation::agentLabel)?.substringBefore(' ') ?: "The agent"
                Text(
                    "$who is working — sending will queue your message",
                    style = OptioTheme.type.caption2,
                    color = OptioTheme.colors.secondaryLabel,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.l).padding(bottom = 2.dp),
                )
            }
            ChatComposer(
                onSend = onSend,
                placeholder = "Message the agent",
                autofocus = autofocus,
                windowInsets = WindowInsets(0, 0, 0, 0),
            )
        }
    }
}

// endregion

// region Screen face

/**
 * The Screen face (iOS `LocalTerminalStreamView`): a strip only when the stream isn't healthy, the
 * "Sized for another device" strip with "Use this screen" (or "Recorded screen" for an exited
 * terminal), the terminal, an error banner, and the extra-keys bar. A finished terminal that never
 * streamed a byte (a row from before screens were recorded) shows its text preview instead; the two
 * never stack.
 */
@Composable
internal fun ScreenFace(
    terminal: LocalTerminal,
    screen: TerminalState,
    stream: LocalTerminalStream.State,
    canType: Boolean,
    onClaim: () -> Unit,
    onReconnect: () -> Unit,
    modifier: Modifier = Modifier,
    onStart: () -> Unit = {},
    dark: Boolean = optioIsDark(),
) {
    val background = TerminalTheme.background(dark)
    if (terminal.state == LocalTerminalState.PENDING) {
        PendingScreen(terminal, canType, onStart, modifier.background(background))
        return
    }
    val showPreview =
        LocalPresentation.isDead(terminal) && stream.settled && !stream.outputSeen && !terminal.preview.isNullOrEmpty()
    Column(modifier.fillMaxSize().background(background).keyboardPadding().testTag("screen-face")) {
        if (stream.conn != LocalTerminalStream.ConnState.CONNECTED) {
            Strip(dot = connColor(stream.conn), background = background) {
                Text(stream.conn.label, maxLines = 1)
            }
        }
        stream.foreignGrid?.let { grid ->
            Strip(dot = Tone.WORKING.color, background = background, testTag = "grid-strip") {
                Text(
                    buildAnnotatedString {
                        append(if (stream.recorded) "Recorded screen" else "Sized for another device")
                        withStyle(SpanStyle(color = OptioTheme.colors.tertiaryLabel)) { append("  ${grid.cols}×${grid.rows}") }
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (!stream.recorded && canType) {
                    TextButton(
                        onClick = onClaim,
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                        modifier = Modifier.height(28.dp).testTag("use-this-screen"),
                    ) {
                        Icon(Icons.Outlined.OpenInFull, contentDescription = null, modifier = Modifier.size(14.dp))
                        Text("Use this screen", style = OptioTheme.type.caption.semibold(), modifier = Modifier.padding(start = 4.dp))
                    }
                }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (showPreview) {
                LastOutput(terminal.preview.orEmpty(), dark)
            } else {
                TerminalSurface(
                    state = screen,
                    modifier = Modifier.fillMaxSize(),
                    dark = dark,
                    inputMode = if (LocalPresentation.isAgent(terminal)) TerminalInputMode.Prose else TerminalInputMode.Text,
                    readOnly = stream.dead || !canType,
                )
            }
            stream.errorMessage?.let { message ->
                ErrorBanner(
                    message = message,
                    retrying = stream.retrying,
                    showReconnect = !stream.retrying && stream.conn == LocalTerminalStream.ConnState.DISCONNECTED && !stream.dead,
                    onReconnect = onReconnect,
                    modifier = Modifier.align(Alignment.TopCenter),
                )
            }
        }
        if (!stream.dead && canType) {
            TerminalKeyBar(screen, enabled = stream.connected, dark = dark)
        }
    }
}

/**
 * A terminal that hasn't started has no screen yet (the stream only attaches to a launching or
 * running one): say why, and offer Start when it's held.
 */
@Composable
private fun PendingScreen(
    terminal: LocalTerminal,
    canStart: Boolean,
    onStart: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val offline = terminal.pendingReason == LocalTerminalPendingReason.HOST_OFFLINE
    Box(modifier.fillMaxSize().testTag("pending-screen"), contentAlignment = Alignment.Center) {
        EmptyState(
            title = if (offline) "Waiting for the host" else "Not started yet",
            icon = if (offline) Icons.Outlined.WifiOff else Icons.Outlined.Terminal,
            message =
                if (offline) {
                    "It starts by itself when the machine reconnects (`optio local up`)."
                } else {
                    "This terminal is held: it runs when you start it."
                },
            actionTitle = if (canStart && LocalPresentation.canStart(terminal)) "Start" else null,
            action = if (canStart && LocalPresentation.canStart(terminal)) onStart else null,
        )
    }
}

@Composable
private fun LastOutput(
    preview: String,
    dark: Boolean,
) {
    Column(Modifier.fillMaxSize().padding(10.dp).testTag("last-output"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Last output", style = OptioTheme.type.sectionHeader, color = OptioTheme.colors.secondaryLabel)
        SelectionContainer(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) {
            Text(preview, style = OptioTheme.type.monoCaption, color = TerminalTheme.foreground(dark))
        }
    }
}

@Composable
private fun Strip(
    dot: Color,
    background: Color,
    testTag: String = "conn-strip",
    content: @Composable RowScope.() -> Unit,
) {
    Column(Modifier.fillMaxWidth().background(background).testTag(testTag)) {
        Row(
            Modifier.fillMaxWidth().height(32.dp).padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(6.dp).background(dot, Radius.capsuleShape))
            androidx.compose.runtime.CompositionLocalProvider(
                androidx.compose.material3.LocalContentColor provides OptioTheme.colors.secondaryLabel,
                androidx.compose.material3.LocalTextStyle provides OptioTheme.type.caption,
            ) {
                content()
            }
        }
        HorizontalDivider(thickness = 0.5.dp, color = OptioTheme.colors.separator)
    }
}

@Composable
private fun ErrorBanner(
    message: String,
    retrying: Boolean,
    showReconnect: Boolean,
    onReconnect: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    Surface(
        modifier = modifier.padding(10.dp).fillMaxWidth().testTag("stream-error"),
        shape = Radius.cardShape,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shadowElevation = 2.dp,
    ) {
        Row(Modifier.padding(10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(
                if (retrying) Icons.Outlined.WifiOff else Icons.Outlined.ErrorOutline,
                contentDescription = null,
                tint = if (retrying) colors.secondaryLabel else colors.red,
                modifier = Modifier.size(18.dp),
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(message, style = OptioTheme.type.footnote.medium(), color = if (retrying) colors.label else colors.red)
                if (retrying) {
                    Text("Retrying every 2s — start `optio local up` on the host.", style = OptioTheme.type.caption2, color = colors.secondaryLabel)
                }
            }
            if (showReconnect) {
                TextButton(onClick = onReconnect, modifier = Modifier.testTag("reconnect")) { Text("Reconnect", style = OptioTheme.type.caption.semibold()) }
            } else if (retrying) {
                CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp, color = colors.secondaryLabel)
            }
        }
    }
}

@Composable
private fun connColor(conn: LocalTerminalStream.ConnState): Color =
    when (conn) {
        LocalTerminalStream.ConnState.CONNECTING, LocalTerminalStream.ConnState.RECONNECTING -> Tone.IDLE.color
        LocalTerminalStream.ConnState.CONNECTED -> Tone.SUCCESS.color
        LocalTerminalStream.ConnState.DISCONNECTED -> Tone.DANGER.color
    }

// endregion

/**
 * Bottom padding that keeps this column's bottom (a composer, the key bar) on top of the keyboard.
 * `imePadding()` alone measures from the window's bottom edge; a detail screen inside the tab
 * shell ends above the navigation bar, so it would float that far above the keyboard. This pads by
 * exactly the part of the keyboard that overlaps the column.
 */
internal fun Modifier.keyboardPadding(): Modifier =
    composed {
        val density = LocalDensity.current
        val imeBottom = WindowInsets.ime.getBottom(density)
        val windowHeight = LocalWindowInfo.current.containerSize.height
        var bottomGap by remember { mutableIntStateOf(0) }
        val overlap = max(0, imeBottom - bottomGap)
        this
            .onGloballyPositioned { coordinates ->
                val bottom = coordinates.boundsInWindow().bottom
                bottomGap = max(0, (windowHeight - bottom).roundToInt())
            }.padding(bottom = with(density) { overlap.toDp() })
    }
