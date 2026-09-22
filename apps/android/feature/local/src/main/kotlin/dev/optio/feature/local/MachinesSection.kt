package dev.optio.feature.local

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.optio.core.navigation.routes.LocalAutomationRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.ui.PlaceholderSection

/** Library › Machines: Optio Local hosts, terminals, automations (iOS `MachinesView`). Stub: Agent A5. */
@Composable
fun MachinesSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    PlaceholderSection(
        title = "Machines",
        contentPadding = contentPadding,
        modifier = modifier,
        samples = listOf(LocalTerminalRoute("sample-terminal"), LocalAutomationRoute("sample-automation")),
    )
}
