package dev.optio.core.ui.log

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardReturn
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.Dangerous
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.UnfoldLess
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.boolValue
import dev.optio.core.model.intValue
import dev.optio.core.model.stringValue
import dev.optio.core.ui.components.MarkdownText
import dev.optio.core.ui.format.LocalClock
import dev.optio.core.ui.format.isoInstant
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.italic
import dev.optio.core.ui.theme.mono
import dev.optio.core.ui.theme.semibold
import dev.optio.core.ui.theme.tabularNums
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * A transcript of [AgentLogEntry] rows rendered the way the web log viewer does (iOS
 * `AgentLogView`): assistant text as Markdown prose, prompts you typed as a "You" card, thinking
 * dimmed, tool calls as collapsible mono blocks (with their paired result folded under them),
 * errors red, system lines small mono. Used for task logs, job-run logs, review logs, session chat
 * and persistent-agent turns alike, so every surface reads the same.
 *
 * With [autoScroll] the list opens at the newest entry and follows new entries while the reader is
 * at the bottom; scrolling up stops following until they return. [emptyContent] shows instead of
 * an empty list. Test tag: `agent-log`; rows `log-row-<index>`.
 */
@Composable
fun AgentLogView(
    entries: List<AgentLogEntry>,
    modifier: Modifier = Modifier,
    autoScroll: Boolean = true,
    state: LazyListState = rememberLazyListState(),
    contentPadding: PaddingValues = PaddingValues(Spacing.l),
    emptyContent: (@Composable () -> Unit)? = null,
) {
    if (entries.isEmpty() && emptyContent != null) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) { emptyContent() }
        return
    }
    var previousCount by remember { mutableIntStateOf(0) }
    LaunchedEffect(entries.size) {
        val count = entries.size
        val previous = previousCount
        previousCount = count
        if (!autoScroll || count == 0) return@LaunchedEffect
        // Follow when the reader could see the end of the previous last entry (appending doesn't
        // move the list). Reading up inside a long last entry is reading back: stay put.
        val info = state.layoutInfo
        val previousLast = info.visibleItemsInfo.firstOrNull { it.index == previous - 1 }
        val sawEnd = previousLast != null &&
            previousLast.offset + previousLast.size <= info.viewportEndOffset - info.afterContentPadding + FOLLOW_SLACK_PX
        if (previous == 0 || sawEnd) state.scrollToBottom(animated = previous != 0)
    }
    LazyColumn(
        state = state,
        modifier = modifier.fillMaxSize().testTag("agent-log"),
        contentPadding = contentPadding,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        itemsIndexed(entries, key = { index, _ -> index }) { index, entry ->
            AgentLogRow(entry, Modifier.testTag("log-row-$index"))
        }
    }
}

/** How far above the end of the last entry still counts as "at the bottom". */
private const val FOLLOW_SLACK_PX = 48

/** Scrolls to the end of the last item (iOS `scrollTo(last, anchor: .bottom)`). */
private suspend fun LazyListState.scrollToBottom(animated: Boolean) {
    val last = layoutInfo.totalItemsCount - 1
    if (last < 0) return
    if (animated) animateScrollToItem(last) else scrollToItem(last)
    val item = layoutInfo.visibleItemsInfo.lastOrNull() ?: return
    val overflow = item.offset + item.size - (layoutInfo.viewportEndOffset - layoutInfo.afterContentPadding)
    if (overflow > 0) {
        if (animated) animateScrollToItem(last, overflow) else scrollToItem(last, overflow)
    }
}

/**
 * One transcript entry (iOS `AgentLogRow`). Optional metadata a producer may attach: `role: "user"`
 * marks a prompt typed by the human; `toolName` names a tool call; `summary` is a call's one-line
 * summary for the header (the body is then the full input); `result` / `resultIsError` fold the
 * tool's result under its call; a non-zero `exitCode` marks a failed command.
 */
@Composable
fun AgentLogRow(
    entry: AgentLogEntry,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val meta = entry.metadata
    val role = meta?.get("role")?.stringValue
    val source = meta?.get("source")?.stringValue
    when (entry.type) {
        AgentLogEntry.TypeValue.TEXT -> if (role == "user" || role == "prompt") {
            UserPrompt(entry, modifier, prompt = role == "prompt")
        } else {
            SelectionContainer(modifier.fillMaxWidth()) { MarkdownText(entry.content) }
        }
        AgentLogEntry.TypeValue.SYSTEM -> if (source != null) {
            SystemNote(entry, source, modifier)
        } else {
            SelectionContainer(modifier.fillMaxWidth()) {
                Text(entry.content, style = type.caption.mono(), color = colors.secondaryLabel)
            }
        }
        AgentLogEntry.TypeValue.THINKING -> SelectionContainer(modifier.fillMaxWidth()) {
            Text(entry.content, style = type.footnote.italic(), color = colors.secondaryLabel)
        }
        AgentLogEntry.TypeValue.TOOL_USE, AgentLogEntry.TypeValue.TOOL_RESULT -> ToolBlock(entry, modifier)
        AgentLogEntry.TypeValue.ERROR -> Row(
            modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Outlined.Dangerous, contentDescription = "Error", tint = colors.red, modifier = Modifier.padding(top = 1.dp).size(16.dp))
            SelectionContainer { Text(entry.content, style = type.monoFootnote, color = colors.red) }
        }
        AgentLogEntry.TypeValue.INFO, AgentLogEntry.TypeValue.UNKNOWN -> SelectionContainer(modifier.fillMaxWidth()) {
            Text(entry.content, style = type.caption.mono(), color = colors.secondaryLabel)
        }
    }
}

/**
 * A turn typed by the person ("You"), or with [prompt] the prompt the session was started with
 * (the New work form, an automation's template) rather than something typed into it.
 */
@Composable
private fun UserPrompt(entry: AgentLogEntry, modifier: Modifier, prompt: Boolean = false) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val tint = if (prompt) colors.secondaryLabel else colors.accent
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
        Box(
            Modifier
                .size(22.dp)
                .background(if (prompt) colors.fillTertiary else colors.accent.copy(alpha = 0.15f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                if (prompt) Icons.Outlined.Description else Icons.Filled.Person,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(13.dp),
            )
        }
        Column(
            Modifier
                .weight(1f)
                .background(colors.fillTertiary, Radius.cardShape)
                .padding(horizontal = Spacing.m, vertical = Spacing.s),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (prompt) "Prompt" else "You", style = type.caption.semibold(), color = tint)
                shortTime(entry.timestamp, LocalClock.current.zone)?.let { Text(it, style = type.caption2.tabularNums(), color = colors.tertiaryLabel) }
            }
            SelectionContainer { Text(entry.content, style = type.callout, color = colors.label) }
        }
    }
}

/**
 * A turn the agent CLI filed as the person's but isn't: a background task reporting back, another
 * agent's message, a compaction summary, an interruption (iOS `systemNote`). The first line reads
 * inline; the rest folds away.
 */
@Composable
private fun SystemNote(entry: AgentLogEntry, source: String, modifier: Modifier) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val (label, icon, folds) = systemTurn(source)
    val newline = entry.content.indexOf('\n')
    val head = if (folds) label else "$label · ${if (newline >= 0) entry.content.substring(0, newline) else entry.content}"
    val rest = if (folds) entry.content else if (newline >= 0) entry.content.substring(newline + 1).trim() else ""
    var expanded by rememberSaveable { mutableStateOf(false) }
    Column(
        modifier
            .fillMaxWidth()
            .background(colors.fillQuaternary, Radius.cardShape)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .then(if (rest.isNotEmpty()) Modifier.clickable(role = Role.Button) { expanded = !expanded } else Modifier)
                .semantics { if (rest.isNotEmpty()) stateDescription = if (expanded) "Expanded" else "Collapsed" },
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (rest.isNotEmpty()) {
                Icon(
                    Icons.Filled.ExpandMore,
                    contentDescription = null,
                    tint = colors.secondaryLabel,
                    modifier = Modifier.padding(top = 1.dp).size(14.dp).rotate(if (expanded) 0f else -90f),
                )
            }
            Icon(icon, contentDescription = null, tint = colors.secondaryLabel, modifier = Modifier.padding(top = 1.dp).size(14.dp))
            Text(
                head,
                style = type.caption,
                color = colors.secondaryLabel,
                maxLines = if (expanded) Int.MAX_VALUE else 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
        AnimatedVisibility(expanded && rest.isNotEmpty(), enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            SelectionContainer { Text(rest, style = type.caption, color = colors.secondaryLabel) }
        }
    }
}

/** Label, icon, and whether the whole text folds away, per transcript `source`. */
private fun systemTurn(source: String): Triple<String, ImageVector, Boolean> = when (source) {
    "task" -> Triple("Background task", Icons.Outlined.Notifications, false)
    "agent" -> Triple("Message from another agent", Icons.Outlined.Groups, false)
    "compact" -> Triple("Earlier conversation summarized", Icons.Outlined.UnfoldLess, true)
    "interrupt" -> Triple("Interrupted", Icons.Outlined.Block, false)
    "rewind" -> Triple("Rolled back", Icons.AutoMirrored.Outlined.Undo, false)
    else -> Triple("From the agent CLI", Icons.Outlined.Info, true)
}

@Composable
private fun ToolBlock(entry: AgentLogEntry, modifier: Modifier) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val meta = entry.metadata
    val isUse = entry.type == AgentLogEntry.TypeValue.TOOL_USE
    val toolName = meta?.get("toolName")?.stringValue ?: if (isUse) "tool" else "result"
    val summary = meta?.get("summary")?.stringValue
    val pairedResult = meta?.get("result")?.stringValue
    val exitCode = meta?.get("exitCode")?.intValue
    val isError = meta?.get("resultIsError")?.boolValue == true || (exitCode ?: 0) != 0
    val hasBody = entry.content.isNotEmpty() || pairedResult != null
    var expanded by rememberSaveable { mutableStateOf(false) }
    val chevron by animateFloatAsState(if (expanded) 180f else 0f, label = "chevron")

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        val header = if (hasBody) {
            Modifier
                .clickable(role = Role.Button, onClickLabel = if (expanded) "Collapse" else "Expand") { expanded = !expanded }
                .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }
        } else {
            Modifier.padding(start = 2.dp)
        }
        Row(
            header.fillMaxWidth().padding(vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                when {
                    isError -> Icons.Outlined.ErrorOutline
                    isUse -> Icons.Outlined.Build
                    else -> Icons.AutoMirrored.Outlined.KeyboardReturn
                },
                contentDescription = null,
                tint = if (isError) colors.red else colors.secondaryLabel,
                modifier = Modifier.size(15.dp),
            )
            Text(
                toolName,
                style = type.caption.semibold().mono(),
                color = if (isError) colors.red else colors.label,
                maxLines = 1,
            )
            if (exitCode != null && exitCode != 0) {
                Text("exit $exitCode", style = type.caption2, color = colors.red, maxLines = 1)
            }
            Text(
                (summary ?: entry.content).take(80).replace('\n', ' '),
                style = type.caption2.mono(),
                color = colors.tertiaryLabel,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(start = 2.dp),
            )
            if (hasBody) {
                Icon(
                    Icons.Filled.ExpandMore,
                    contentDescription = null,
                    tint = colors.tertiaryLabel,
                    modifier = Modifier.size(18.dp).rotate(chevron),
                )
            }
        }
        AnimatedVisibility(expanded && hasBody, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (entry.content.isNotEmpty()) {
                    SelectionContainer {
                        Text(
                            entry.content,
                            style = type.caption.mono(),
                            color = colors.label,
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(colors.fillTertiary, Radius.smallShape)
                                .padding(Spacing.s),
                        )
                    }
                }
                if (pairedResult != null) {
                    SelectionContainer {
                        Text(
                            pairedResult.ifEmpty { "(no output)" },
                            style = type.caption.mono(),
                            color = if (isError) colors.red else colors.secondaryLabel,
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(colors.fillQuaternary, Radius.smallShape)
                                .padding(Spacing.s),
                        )
                    }
                }
            }
        }
    }
}

private val shortTimeFormatter: DateTimeFormatter = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)

/** "4:02 PM" in the device zone for an ISO timestamp; null when empty or unparseable. */
internal fun shortTime(iso: String, zone: ZoneId = ZoneId.systemDefault()): String? {
    if (iso.isEmpty()) return null
    return iso.isoInstant()?.atZone(zone)?.let(shortTimeFormatter::format)
}
