package dev.optio.feature.more.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.theme.AppAppearance
import dev.optio.core.ui.theme.LocalAppearanceStore
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.collectAppearance
import kotlinx.coroutines.launch

/**
 * Settings › App › Appearance (iOS `Picker(selection: $appearance)` over `AppAppearance`, segmented):
 * System / Light / Dark, stored by core:ui's [dev.optio.core.ui.theme.AppearanceStore] and applied
 * app-wide at once. Without a store (previews, tests) it shows System and ignores taps.
 */
@Composable
fun AppearancePicker(modifier: Modifier = Modifier) {
    val store = LocalAppearanceStore.current
    val scope = rememberCoroutineScope()
    AppearanceRow(
        selection = store.collectAppearance(),
        onSelect = { appearance -> scope.launch { store?.set(appearance) } },
        modifier = modifier,
    )
}

/** The appearance row, stateless: a label with its symbol, then the three segments. */
@Composable
fun AppearanceRow(
    selection: AppAppearance,
    onSelect: (AppAppearance) -> Unit,
    modifier: Modifier = Modifier,
) {
    val haptics = LocalHapticFeedback.current
    Column(modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m).testTag("appearance")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(AppAppearance.SYSTEM.icon, contentDescription = null, tint = OptioTheme.colors.secondaryLabel, modifier = Modifier.size(22.dp))
            Text("Appearance", style = OptioTheme.type.body, color = OptioTheme.colors.label, modifier = Modifier.padding(start = Spacing.l))
        }
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(top = Spacing.m)) {
            AppAppearance.entries.forEachIndexed { index, appearance ->
                SegmentedButton(
                    selected = appearance == selection,
                    onClick = {
                        if (appearance != selection) haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                        onSelect(appearance)
                    },
                    shape = SegmentedButtonDefaults.itemShape(index = index, count = AppAppearance.entries.size),
                    icon = { SegmentedButtonDefaults.Icon(active = appearance == selection) { Icon(appearance.icon, contentDescription = null, modifier = Modifier.size(18.dp)) } },
                    label = { Text(appearance.label, maxLines = 1) },
                    modifier = Modifier.testTag("appearance-${appearance.raw}"),
                )
            }
        }
    }
}
