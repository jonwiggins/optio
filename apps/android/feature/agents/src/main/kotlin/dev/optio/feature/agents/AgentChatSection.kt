package dev.optio.feature.agents

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.optio.core.model.PersistentAgentMessage
import dev.optio.core.model.PersistentAgentMessageSenderType
import dev.optio.core.model.PersistentAgentTurn
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.MessageBubble
import dev.optio.core.ui.components.MessageRole
import dev.optio.core.ui.components.PullRefresh
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.log.AgentLogRow
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.semibold
import java.time.Instant
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/**
 * Inbox messages as bubbles, then the live activity tail of the current turn, in one scroll (iOS
 * `AgentChatSection`). New messages and log lines follow the bottom while the reader is there.
 * The composer lives in the screen, under this.
 */
@Composable
internal fun AgentChatSection(
    messages: LoadState<List<PersistentAgentMessage>>,
    live: AgentLiveTail,
    turns: List<PersistentAgentTurn>,
    onRefresh: suspend () -> Unit,
    modifier: Modifier = Modifier,
    state: LazyListState = rememberLazyListState(),
) {
    val list = messages.value
    val now = rememberNow()
    val scope = rememberCoroutineScope()
    FollowBottom(state, count = (list?.size ?: 0) + live.entries.size)

    PullRefresh(onRefresh = onRefresh, modifier = modifier) {
        LazyColumn(
            state = state,
            modifier = Modifier.fillMaxSize().testTag("agent-chat"),
            contentPadding = PaddingValues(Spacing.l),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            when {
                list == null && messages is LoadState.Failed ->
                    item { ErrorRow(error = messages.error, what = "messages", retry = { scope.launch { onRefresh() } }) }
                list == null -> item { SkeletonRows(count = 3) }
                list.isEmpty() && live.entries.isEmpty() ->
                    item {
                        Text(
                            "No messages yet. Send one below to wake the agent.",
                            style = OptioTheme.type.footnote,
                            color = OptioTheme.colors.secondaryLabel,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().padding(top = Spacing.xl),
                        )
                    }
            }
            items(list.orEmpty(), key = { it.id }) { message -> AgentMessageBubble(message, now) }
            if (live.entries.isNotEmpty()) {
                item(key = "live-header") {
                    val turn = turns.firstOrNull { it.id == live.turnId }
                    LiveActivityHeader(turnNumber = turn?.turnNumber?.toInt())
                }
                itemsIndexed(live.entries, key = { index, _ -> "live-$index" }) { _, entry -> AgentLogRow(entry) }
            }
        }
    }
}

/** "Live activity · turn #3" above the tail. */
@Composable
private fun LiveActivityHeader(turnNumber: Int?) {
    val colors = OptioTheme.colors
    Row(
        modifier = Modifier.padding(top = Spacing.s).testTag("live-activity"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(Icons.Outlined.GraphicEq, contentDescription = null, tint = colors.secondaryLabel, modifier = Modifier.size(14.dp))
        val text = if (turnNumber != null) "Live activity · turn #$turnNumber" else "Live activity"
        Text(text, style = OptioTheme.type.caption.semibold(), color = colors.secondaryLabel)
    }
}

/**
 * One inbox message (iOS `AgentMessageBubble`): yours trailing, the agent's as prose, system and
 * external notes small. The meta line names non-user senders, broadcasts, the time, and "pending"
 * until a turn drained it.
 */
@Composable
internal fun AgentMessageBubble(
    message: PersistentAgentMessage,
    now: Instant,
    modifier: Modifier = Modifier,
) {
    val role =
        when (message.senderType) {
            PersistentAgentMessageSenderType.USER -> MessageRole.USER
            PersistentAgentMessageSenderType.AGENT -> MessageRole.AGENT
            else -> MessageRole.SYSTEM
        }
    val sender =
        if (message.senderType == PersistentAgentMessageSenderType.USER) {
            null
        } else {
            val type = if (message.senderType == PersistentAgentMessageSenderType.UNKNOWN) "unknown" else message.senderType.raw
            "$type:${message.senderName ?: "unknown"}"
        }
    val meta =
        listOfNotNull(
            sender,
            "broadcast".takeIf { message.broadcasted },
            message.receivedAt.sinceDescription(now),
            "pending".takeIf { message.processedAt == null },
        ).joinToString(" · ")
    MessageBubble(
        role = role,
        text = message.body,
        meta = meta,
        pending = message.processedAt == null,
        modifier = modifier.testTag("message-${message.id}"),
    )
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
