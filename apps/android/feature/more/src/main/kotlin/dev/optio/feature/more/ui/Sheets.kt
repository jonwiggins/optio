package dev.optio.feature.more.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.ProvideElevatedSurfaces
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.semibold

/**
 * A modal bottom sheet for the More tab's small forms and pickers (iOS `.sheet` with a
 * `NavigationStack` toolbar): a [title] row with an optional [dismissLabel] on the left and
 * [confirmLabel] on the right, then [content] on the raised grouped surface, scrolling.
 *
 * [dismissible] = false keeps the sheet up against swipes and taps outside (iOS
 * `interactiveDismissDisabled`), e.g. while a new token is on screen.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun MoreSheet(
    title: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    dismissLabel: String? = "Cancel",
    confirmLabel: String? = null,
    confirmEnabled: Boolean = true,
    busy: Boolean = false,
    onConfirm: () -> Unit = {},
    dismissible: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    val canDismiss by rememberUpdatedState(dismissible)
    val sheetState = rememberModalBottomSheetState(
        skipPartiallyExpanded = true,
        confirmValueChange = { value -> value != SheetValue.Hidden || canDismiss },
    )
    val elevated = OptioTheme.colors.elevated()
    ModalBottomSheet(
        onDismissRequest = { if (dismissible) onDismiss() },
        sheetState = sheetState,
        containerColor = elevated.page,
        // A sheet that can't be swiped away shows no handle.
        dragHandle = if (dismissible) ({ BottomSheetDefaults.DragHandle() }) else null,
        // The sheet is its own window: expose test tags as resource ids here too, as the shell does.
        modifier = modifier.semantics { testTagsAsResourceId = true }.testTag("more-sheet"),
    ) {
        ProvideElevatedSurfaces {
            Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
                // Without the drag handle, the title row takes its place at the top.
                Box(Modifier.fillMaxWidth().padding(start = Spacing.s, end = Spacing.s, top = if (dismissible) 0.dp else Spacing.l)) {
                    if (dismissLabel != null) {
                        TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.CenterStart).testTag("sheet-dismiss")) {
                            Text(dismissLabel)
                        }
                    }
                    Text(
                        title,
                        style = OptioTheme.type.headline,
                        color = OptioTheme.colors.label,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.align(Alignment.Center).padding(horizontal = 96.dp),
                        maxLines = 1,
                    )
                    if (confirmLabel != null) {
                        Row(Modifier.align(Alignment.CenterEnd), verticalAlignment = Alignment.CenterVertically) {
                            if (busy) {
                                CircularProgressIndicator(Modifier.padding(end = Spacing.l).size(20.dp), strokeWidth = 2.dp)
                            } else {
                                TextButton(onClick = onConfirm, enabled = confirmEnabled, modifier = Modifier.testTag("sheet-confirm")) {
                                    Text(confirmLabel, style = OptioTheme.type.body.semibold())
                                }
                            }
                        }
                    }
                }
                Column(
                    Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = Spacing.xl),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                    content = content,
                )
            }
        }
    }
}
