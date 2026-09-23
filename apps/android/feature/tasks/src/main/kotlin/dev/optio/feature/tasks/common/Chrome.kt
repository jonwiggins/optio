package dev.optio.feature.tasks.common

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.optio.core.navigation.LocalNavigator

/**
 * A detail screen's frame: a top app bar with a back button, [title] and [actions], then
 * [content] with the bar's padding. [bottomBar] holds a composer.
 */
@Composable
fun DetailScaffold(
    title: String,
    modifier: Modifier = Modifier,
    actions: @Composable RowScope.() -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    val navigator = LocalNavigator.current
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = { navigator.pop() }, modifier = Modifier.testTag("back")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = actions,
            )
        },
        bottomBar = bottomBar,
        content = content,
    )
}

/**
 * A full-screen form's frame (Material's full-screen dialog pattern, iOS form sheets): a close
 * button, [title], and the confirm text button ([confirmLabel], spinner while [saving]).
 */
@Composable
fun FormScaffold(
    title: String,
    confirmLabel: String,
    canConfirm: Boolean,
    saving: Boolean,
    onConfirm: () -> Unit,
    modifier: Modifier = Modifier,
    onClose: (() -> Unit)? = null,
    content: @Composable (PaddingValues) -> Unit,
) {
    val navigator = LocalNavigator.current
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onClose ?: { navigator.pop() }, enabled = !saving, modifier = Modifier.testTag("back")) {
                        Icon(Icons.Filled.Close, contentDescription = "Cancel")
                    }
                },
                actions = {
                    if (saving) {
                        Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        }
                    } else {
                        TextButton(onClick = onConfirm, enabled = canConfirm, modifier = Modifier.testTag("form-confirm")) {
                            Text(confirmLabel, fontWeight = FontWeight.SemiBold)
                        }
                    }
                },
            )
        },
        content = content,
    )
}

/** One item of an [OverflowMenu]. */
data class MenuAction(
    val label: String,
    val icon: ImageVector? = null,
    val destructive: Boolean = false,
    val enabled: Boolean = true,
    val testTag: String? = null,
    /** Draw a divider above this item. */
    val dividerBefore: Boolean = false,
    val onClick: () -> Unit,
)

/**
 * The overflow menu of a detail's top bar (iOS `Menu { … } label: { ellipsis.circle }`): a spinner
 * instead of the button while [busy]. Test tags: `overflow`, and each item's [MenuAction.testTag].
 */
@Composable
fun OverflowMenu(
    items: List<MenuAction>,
    modifier: Modifier = Modifier,
    busy: Boolean = false,
) {
    var open by remember { mutableStateOf(false) }
    if (busy) {
        Box(modifier.size(48.dp), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        }
        return
    }
    if (items.isEmpty()) return
    Box(modifier) {
        IconButton(onClick = { open = true }, modifier = Modifier.testTag("overflow")) {
            Icon(Icons.Filled.MoreVert, contentDescription = "More")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            items.forEachIndexed { index, item ->
                if (item.dividerBefore && index > 0) HorizontalDivider()
                val color = if (item.destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
                DropdownMenuItem(
                    text = { Text(item.label) },
                    onClick = {
                        open = false
                        item.onClick()
                    },
                    enabled = item.enabled,
                    leadingIcon = item.icon?.let { icon -> { Icon(icon, contentDescription = null) } },
                    colors = MenuDefaults.itemColors(textColor = color, leadingIconColor = color),
                    modifier = item.testTag?.let { Modifier.testTag(it) } ?: Modifier,
                )
            }
        }
    }
}
