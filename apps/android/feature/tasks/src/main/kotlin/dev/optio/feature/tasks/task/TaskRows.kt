package dev.optio.feature.tasks.task

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.StatusBadge
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.semibold
import dev.optio.feature.tasks.data.RunFormatting
import dev.optio.feature.tasks.data.TaskActivityItem
import dev.optio.feature.tasks.data.TaskRow
import java.time.Instant

/** What a task row shows (iOS `TaskRowView`), apart from the composable, for tests. */
internal object TaskRowText {
    fun tone(task: TaskRow): Tone = if (task.isStalledRunning) Tone.ACCENT else Tone.forState(task.state)

    /** `repo · #519 · Claude Code · $0.78 · review`. */
    fun meta(task: TaskRow): AnnotatedString? = metaText(
        task.repoShortName.takeIf { it.isNotEmpty() },
        task.prNumberLabel?.let(::mono),
        task.agentType?.let(RunFormatting::agentLabel),
        task.costText,
        if (task.taskType == "review") "review" else null,
    )

    /** The trailing time or terminal state, and its tone. */
    fun trailing(task: TaskRow, now: Instant): Pair<String, Tone?> = when (task.state) {
        "completed" -> if (task.prState == "merged") "Merged" to Tone.SUCCESS else "Done" to null
        "failed" -> ("Failed" + (task.completedAt?.let { " ${it.relativeDescription(now)}" } ?: "")) to Tone.DANGER
        "cancelled" -> "Cancelled" to null
        "pr_opened" -> {
            val checks = task.prChecksStatus
            if (checks != null && checks != "none") {
                "CI $checks" to when (checks) {
                    "passing" -> Tone.SUCCESS
                    "failing" -> Tone.DANGER
                    else -> null
                }
            } else {
                "PR open" to null
            }
        }
        "needs_attention" -> "Needs you" to Tone.ACCENT
        else -> if (task.isStalledRunning) "Stalled" to Tone.ACCENT else (task.createdAt?.relativeDescription(now) ?: "") to null
    }

    fun footer(task: TaskRow, subtasks: List<TaskRow> = emptyList()): String? {
        if ((task.state == "failed" || task.state == "needs_attention") && !task.errorMessage.isNullOrEmpty()) return task.errorMessage
        if (task.pendingReason == "waiting_for_off_peak") return "Held for off-peak window"
        if (subtasks.isNotEmpty()) {
            val done = subtasks.count { it.state == "completed" }
            return "${subtasks.size} subtask${if (subtasks.size == 1) "" else "s"} · $done done"
        }
        return null
    }
}

/** A task in a list (subtasks, dependencies, a blueprint's runs): iOS `TaskRowView`. */
@Composable
fun TaskRowView(
    task: TaskRow,
    modifier: Modifier = Modifier,
    subtasks: List<TaskRow> = emptyList(),
    onClick: (() -> Unit)? = null,
    trailingContent: (@Composable androidx.compose.foundation.layout.RowScope.() -> Unit)? = null,
) {
    val now = rememberNow()
    val (trailing, trailingTone) = TaskRowText.trailing(task, now)
    OptioRow(
        title = task.title.ifEmpty { "Untitled task" },
        modifier = modifier.testTag("task-row-${task.id}"),
        tone = TaskRowText.tone(task),
        meta = TaskRowText.meta(task),
        trailing = trailing.takeIf { it.isNotEmpty() },
        trailingTone = trailingTone,
        footer = TaskRowText.footer(task, subtasks)?.let(::AnnotatedString),
        onClick = onClick,
        trailingContent = trailingContent,
    )
}

/**
 * One activity item (iOS `TaskActivityRow`): a state change with its trigger, a message sent to
 * the agent with its delivery, or a comment. [onDelete] (comments) shows a delete button.
 */
@Composable
fun TaskActivityRow(
    item: TaskActivityItem,
    modifier: Modifier = Modifier,
    onDelete: (() -> Unit)? = null,
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val now = rememberNow()
    Row(
        modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m).testTag("activity-${item.id}"),
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            when (item.type) {
                "event" -> {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        item.fromState?.let { from ->
                            StatusBadge(from)
                            Icon(Icons.AutoMirrored.Outlined.ArrowForward, contentDescription = "to", tint = colors.tertiaryLabel, modifier = Modifier.size(12.dp))
                        }
                        StatusBadge(item.toState.orEmpty())
                        item.user?.displayName?.let { Text("by $it", style = type.caption2, color = colors.secondaryLabel) }
                    }
                    item.trigger?.let { Text(it.replace('_', ' '), style = type.caption, color = colors.secondaryLabel) }
                    item.message?.let { Text(it, style = type.caption, color = colors.secondaryLabel, maxLines = 3, overflow = TextOverflow.Ellipsis) }
                }
                "message" -> {
                    val interrupt = item.mode == "interrupt"
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(
                            if (interrupt) Icons.Outlined.PanTool else Icons.AutoMirrored.Outlined.Send,
                            contentDescription = if (interrupt) "Interrupt" else "Message",
                            tint = if (interrupt) colors.secondaryLabel else colors.accent,
                            modifier = Modifier.size(14.dp),
                        )
                        Text(item.user?.displayName ?: "You", style = type.caption.semibold(), color = colors.label)
                        Text(
                            when {
                                item.ackedAt != null -> "acked"
                                item.deliveredAt != null -> "delivered"
                                else -> "sending"
                            },
                            style = type.caption2,
                            color = colors.tertiaryLabel,
                        )
                    }
                    Text(item.content.orEmpty(), style = type.body, color = colors.label)
                }
                else -> {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(Icons.Outlined.ChatBubbleOutline, contentDescription = null, tint = colors.secondaryLabel, modifier = Modifier.size(14.dp))
                        Text(item.user?.displayName ?: "Comment", style = type.caption.semibold(), color = colors.label)
                    }
                    Text(item.content.orEmpty(), style = type.body, color = colors.label)
                }
            }
            item.createdAt?.let { Text(it.relativeDescription(now), style = type.caption2, color = colors.tertiaryLabel) }
        }
        if (onDelete != null) {
            IconButton(onClick = onDelete, modifier = Modifier.testTag("delete-comment-${item.id}")) {
                Icon(Icons.Outlined.Delete, contentDescription = "Delete comment", tint = colors.tertiaryLabel)
            }
        }
    }
}

/** A tappable text row that starts something ("New subtask", "Add dependency"). */
@Composable
fun AddRow(
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: androidx.compose.ui.graphics.vector.ImageVector = Icons.Outlined.ChatBubbleOutline,
) {
    Row(
        modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = Spacing.l, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Icon(icon, contentDescription = null, tint = OptioTheme.colors.accent, modifier = Modifier.size(20.dp))
        Text(title, style = OptioTheme.type.body, color = OptioTheme.colors.accent)
    }
}
