package dev.optio.feature.more.settings

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.toast.LocalToaster
import dev.optio.feature.more.ui.MoreScaffold

/** `AppIconRoute` (iOS `AppIconPickerView`): the launcher icons, switched through activity aliases. */
@Composable
fun AppIconScreen() {
    val context = LocalContext.current
    val toaster = LocalToaster.current
    val haptics = LocalHapticFeedback.current
    var selected by remember { mutableStateOf(AppIcons.current(context)) }
    MoreScaffold("App icon") { padding ->
        AppIconContent(
            selected = selected,
            contentPadding = padding,
            onSelect = { option ->
                if (option != selected) {
                    val previous = selected
                    selected = option
                    haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                    if (!AppIcons.select(context, option)) {
                        selected = previous
                        toaster.error("This build doesn't include alternate app icons.")
                    }
                }
            },
        )
    }
}

/** The icon grid, stateless. */
@Composable
fun AppIconContent(
    selected: AppIconOption,
    contentPadding: PaddingValues,
    onSelect: (AppIconOption) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 150.dp),
        modifier = modifier.fillMaxSize().testTag("app-icons"),
        contentPadding = PaddingValues(
            start = Spacing.l,
            end = Spacing.l,
            top = contentPadding.calculateTopPadding() + Spacing.l,
            bottom = contentPadding.calculateBottomPadding() + Spacing.xl,
        ),
        horizontalArrangement = Arrangement.spacedBy(Spacing.l),
        verticalArrangement = Arrangement.spacedBy(Spacing.l),
    ) {
        items(AppIconOption.entries, key = { it.slug }) { option ->
            IconCard(option = option, isSelected = option == selected, onClick = { onSelect(option) })
        }
        item(span = { GridItemSpan(maxLineSpan) }, key = "footer") {
            Text(
                "Your launcher shows the new icon within a few seconds. Some launchers drop the old icon from the " +
                    "home screen; add Optio again from the app drawer.",
                style = OptioTheme.type.footnote,
                color = OptioTheme.colors.secondaryLabel,
            )
        }
    }
}

@Composable
private fun IconCard(
    option: AppIconOption,
    isSelected: Boolean,
    onClick: () -> Unit,
) {
    val colors = OptioTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(Radius.cardShape)
            .background(colors.card)
            .selectable(selected = isSelected, role = Role.RadioButton, onClick = onClick)
            .padding(Spacing.m)
            .testTag("icon-${option.slug}"),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // The ring sits 5dp outside the thumbnail (iOS overlay with padding -5); the padding stays
        // when unselected so the grid never shifts.
        val ring = if (isSelected) Modifier.border(3.dp, colors.accent, RoundedCornerShape(24.dp)) else Modifier
        Box(ring.padding(5.dp)) {
            AppIconThumbnail(option = option, size = 88.dp)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(option.title, style = OptioTheme.type.headline, color = colors.label)
            if (isSelected) {
                Icon(Icons.Filled.CheckCircle, contentDescription = "Selected", tint = colors.accent, modifier = Modifier.size(18.dp))
            }
        }
        Text(option.story, style = OptioTheme.type.caption, color = colors.secondaryLabel)
    }
}

/** A rounded thumbnail of an icon (iOS `AppIconThumbnail`), drawn from its preview drawable. */
@Composable
fun AppIconThumbnail(
    option: AppIconOption,
    size: Dp,
    modifier: Modifier = Modifier,
) {
    Image(
        painter = painterResource(option.preview),
        contentDescription = null,
        contentScale = ContentScale.Crop,
        modifier = modifier.size(size).clip(RoundedCornerShape(size * 0.22f)),
    )
}
