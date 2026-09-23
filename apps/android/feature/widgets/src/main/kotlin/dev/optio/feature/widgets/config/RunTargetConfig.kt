package dev.optio.feature.widgets.config

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import dev.optio.core.data.ServerProfile
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.state.LoadState
import dev.optio.core.glance.RunTarget
import dev.optio.feature.widgets.Host
import dev.optio.feature.widgets.run.resolveRunTargets
import kotlin.coroutines.cancellation.CancellationException

/**
 * Picks what a Run widget or the Run tile fires (iOS `RunConfigurationIntent` /
 * `RunControlConfigurationIntent`): every paired server's Local blueprints and Jobs, plus "Ask
 * before running" for the widget ([confirm] non-null) and, for a chosen target, a home-screen
 * shortcut ([onPin]).
 */
@Composable
internal fun RunTargetConfig(
    title: String,
    initial: RunTarget?,
    confirm: Boolean?,
    onClose: () -> Unit,
    onSave: (target: RunTarget, confirm: Boolean) -> Unit,
    onOpenApp: () -> Unit,
    onPin: ((RunTarget) -> Unit)? = null,
) {
    var reload by remember { mutableIntStateOf(0) }
    val servers by produceState<List<ServerProfile>?>(null) { value = Host.session()?.registry?.configured().orEmpty() }
    val targets by produceState<LoadState<List<RunTarget>>>(LoadState.Loading(), reload) {
        value =
            try {
                LoadState.Loaded(RunTarget.fetchAll(Host.clients()))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                LoadState.Failed(e)
            }
    }
    var selectedId by rememberSaveable { mutableStateOf(initial?.id) }
    var askFirst by rememberSaveable { mutableStateOf(confirm ?: true) }
    LaunchedEffect(initial?.id) { if (selectedId == null) selectedId = initial?.id }
    // The live row for the selection, else the saved one (offline, or a legacy id).
    val selected = targets.value?.let { resolveRunTargets(listOfNotNull(selectedId), it).firstOrNull() } ?: initial?.takeIf { it.id == selectedId }

    ConfigScreen(
        title = title,
        onClose = onClose,
        primaryLabel = "Save",
        primaryEnabled = selected != null,
        onPrimary = { selected?.let { onSave(it, askFirst) } },
    ) {
        if (servers?.isEmpty() == true) {
            signedOut(onOpenApp)
            return@ConfigScreen
        }
        targetChoices(targets, selectedId, onSelect = { selectedId = it.id }, onRetry = { reload++ })
        if (confirm != null) {
            item(key = "confirm") {
                GroupedSection(footer = "The first tap arms the widget for ten seconds; the second runs it.") {
                    ToggleRow(title = "Ask before running", checked = askFirst, onChange = { askFirst = it }, modifier = Modifier.testTag("config-confirm"))
                }
            }
        }
        if (onPin != null && selected != null) {
            item(key = "pin") {
                GroupedSection(footer = "A launcher shortcut that runs it after one confirmation.") {
                    OptioRow(
                        title = "Add to home screen",
                        meta = metaText("Run ${selected.name}"),
                        onClick = { onPin(selected) },
                        modifier = Modifier.testTag("config-pin"),
                    )
                }
            }
        }
    }
}
