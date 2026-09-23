package dev.optio.core.ui.components

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing

/**
 * Horizontally scrolling filter chips (iOS `ChipPicker`), for filters only (stage, state, repo):
 * section switching is a segmented control ([DetailTabs], the hub switcher). Monochrome: the
 * selected chip is a label-coloured fill with inverted text (the Things / Linear look), the others
 * a quiet fill. One chip row per screen. Each chip gets the test tag `chip-<label>`.
 */
@Composable
fun <T> ChipPicker(
    options: List<Pair<T, String>>,
    selection: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(horizontal = Spacing.l, vertical = Spacing.s),
) {
    val colors = OptioTheme.colors
    val haptics = LocalHapticFeedback.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(contentPadding),
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        options.forEach { (value, label) ->
            val isSelected = selection == value
            FilterChip(
                selected = isSelected,
                onClick = {
                    if (!isSelected) haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                    onSelect(value)
                },
                label = {
                    Text(
                        label,
                        style = OptioTheme.type.subheadline,
                        fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                        maxLines = 1,
                    )
                },
                colors = FilterChipDefaults.filterChipColors(
                    containerColor = colors.fillTertiary,
                    labelColor = colors.label,
                    selectedContainerColor = colors.label,
                    selectedLabelColor = colors.page,
                ),
                border = null,
                modifier = Modifier.testTag("chip-$label"),
            )
        }
    }
}

/**
 * Segmented switcher inside a detail screen (iOS `DetailTabs`: Logs · Activity · …), matching the
 * hubs' section switcher. Each segment gets the test tag `tab-<label>`.
 */
@Composable
fun <T> DetailTabs(
    options: List<Pair<T, String>>,
    selection: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(horizontal = Spacing.l, vertical = Spacing.s),
) {
    val haptics = LocalHapticFeedback.current
    SingleChoiceSegmentedButtonRow(modifier.fillMaxWidth().padding(contentPadding)) {
        options.forEachIndexed { index, (value, label) ->
            SegmentedButton(
                selected = selection == value,
                onClick = {
                    if (selection != value) haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                    onSelect(value)
                },
                shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),
                icon = {},
                label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                modifier = Modifier.testTag("tab-$label"),
            )
        }
    }
}

/** The 7d / 14d / 30d / 90d period switcher shared by Analytics and Costs (iOS `PeriodPicker`). */
@Composable
fun PeriodPicker(
    days: Int,
    onDaysChange: (Int) -> Unit,
    modifier: Modifier = Modifier,
    options: List<Int> = listOf(7, 14, 30, 90),
    contentPadding: PaddingValues = PaddingValues(),
) {
    DetailTabs(
        options = options.map { it to "${it}d" },
        selection = days,
        onSelect = onDaysChange,
        modifier = modifier,
        contentPadding = contentPadding,
    )
}
