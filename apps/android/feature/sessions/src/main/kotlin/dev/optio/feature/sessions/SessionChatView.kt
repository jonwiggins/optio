package dev.optio.feature.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.components.ChatComposer
import dev.optio.core.ui.components.MessageBubble
import dev.optio.core.ui.components.MessageRole
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.log.AgentLogRow
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * The session's agent chat (iOS `SessionChatView`): the transcript (your prompts as bubbles, the
 * agent's events as log rows), "Thinking…" while it works, the last error, then the model picker,
 * Stop while it thinks, and the composer.
 */
@Composable
internal fun SessionChatView(
    chat: SessionChatUi,
    modelConfig: SessionModelConfig?,
    actions: SessionDetailActions,
    modifier: Modifier = Modifier,
    state: LazyListState = rememberLazyListState(),
) {
    val colors = OptioTheme.colors
    val thinking = chat.status == SessionChatConnection.THINKING
    FollowBottom(state, chat.rows.size + if (thinking) 1 else 0)
    Column(modifier) {
        LazyColumn(
            state = state,
            modifier = Modifier.weight(1f).fillMaxWidth().testTag("session-chat"),
            contentPadding = PaddingValues(Spacing.l),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            when {
                chat.rows.isEmpty() && !chat.historyLoaded && chat.error == null -> item { SkeletonRows(count = 3) }
                chat.rows.isEmpty() ->
                    item {
                        Text(
                            "Send a message to start driving the agent in this session's worktree.",
                            style = OptioTheme.type.footnote,
                            color = colors.secondaryLabel,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().padding(top = Spacing.xl),
                        )
                    }
            }
            items(chat.rows, key = { it.id }) { row ->
                when (row) {
                    is SessionChatRow.User -> MessageBubble(role = MessageRole.USER, text = row.text)
                    is SessionChatRow.Entry -> AgentLogRow(row.entry)
                }
            }
            if (thinking) {
                item(key = "thinking") {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = colors.secondaryLabel)
                        Text("Thinking…", style = OptioTheme.type.caption, color = colors.secondaryLabel)
                    }
                }
            }
        }
        chat.error?.let { error ->
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.xs).testTag("chat-error"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Spacing.s),
            ) {
                Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = colors.red, modifier = Modifier.size(16.dp))
                Text(error, style = OptioTheme.type.footnote, color = colors.secondaryLabel)
            }
        }
        val models = modelConfig?.availableModels.orEmpty()
        if (models.isNotEmpty() || thinking) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surfaceContainer)
                    .padding(horizontal = Spacing.s),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (models.isNotEmpty()) {
                    ModelPicker(
                        current = chat.model ?: modelConfig?.claudeModel,
                        models = models,
                        enabled = chat.status != SessionChatConnection.DISCONNECTED,
                        onPick = actions::setModel,
                    )
                }
                Spacer(Modifier.weight(1f))
                if (thinking) {
                    TextButton(onClick = actions::interrupt, modifier = Modifier.testTag("chat-interrupt")) {
                        Icon(Icons.Outlined.StopCircle, contentDescription = null, modifier = Modifier.size(18.dp))
                        Text("Stop", modifier = Modifier.padding(start = 6.dp))
                    }
                }
            }
        }
        ChatComposer(
            onSend = { text -> actions.send(text) },
            placeholder = "Message the agent…",
            enabled = chat.canSend,
        )
    }
}

/** The model the next prompt runs on (iOS `Menu` with `cpu`). */
@Composable
private fun ModelPicker(
    current: String?,
    models: List<String>,
    enabled: Boolean,
    onPick: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }, enabled = enabled, modifier = Modifier.testTag("chat-model")) {
            Icon(Icons.Outlined.Memory, contentDescription = null, modifier = Modifier.size(16.dp))
            Text(current ?: "model", style = OptioTheme.type.footnote, modifier = Modifier.padding(start = 6.dp))
            Icon(Icons.Filled.ArrowDropDown, contentDescription = null, modifier = Modifier.size(18.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            models.forEach { model ->
                DropdownMenuItem(
                    text = { Text(model) },
                    leadingIcon = {
                        if (model == current) Icon(Icons.Filled.Check, contentDescription = "Selected") else Spacer(Modifier.size(24.dp))
                    },
                    onClick = {
                        open = false
                        onPick(model)
                    },
                )
            }
        }
    }
}

/**
 * Keeps [state] at the bottom as [count] grows, but only while the reader is there (scrolling up
 * stops following until they come back). The first content jumps there, and while following, the
 * viewport shrinking (the keyboard coming up) keeps the end in view.
 */
@Composable
internal fun FollowBottom(
    state: LazyListState,
    count: Int,
) {
    var lastTotal by remember(state) { mutableIntStateOf(0) }
    var following by remember(state) { mutableStateOf(true) }
    // Whether we follow is decided where a scroll (the reader's, or ours) comes to rest.
    LaunchedEffect(state) {
        snapshotFlow { state.isScrollInProgress }.collect { scrolling -> if (!scrolling) following = !state.canScrollForward }
    }
    LaunchedEffect(state) {
        snapshotFlow { state.layoutInfo.viewportSize.height }.distinctUntilChanged().collect {
            if (following && lastTotal > 0) state.scrollToEnd(animated = false)
        }
    }
    LaunchedEffect(state, count) {
        if (count == 0) return@LaunchedEffect
        val info = state.layoutInfo
        val total = info.totalItemsCount
        val lastVisible = info.visibleItemsInfo.lastOrNull()?.index ?: -1
        val first = lastTotal == 0
        val follow = first || following || lastVisible >= lastTotal - 1
        lastTotal = total
        if (total > 0 && follow) state.scrollToEnd(animated = !first)
    }
}

/** Scrolls to the end of the last item, even when it is taller than the viewport. */
internal suspend fun LazyListState.scrollToEnd(animated: Boolean) {
    val last = layoutInfo.totalItemsCount - 1
    if (last < 0) return
    if (animated) animateScrollToItem(last) else scrollToItem(last)
    val item = layoutInfo.visibleItemsInfo.lastOrNull() ?: return
    val overflow = item.offset + item.size - (layoutInfo.viewportEndOffset - layoutInfo.afterContentPadding)
    if (overflow > 0) {
        if (animated) animateScrollToItem(last, overflow) else scrollToItem(last, overflow)
    }
}
