package dev.optio.feature.overview

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.WorkView
import dev.optio.core.navigation.routes.AgentDetailRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.ui.PlaceholderSection

/**
 * The Overview hub's content (iOS `Features/Overview`). The hub chrome (title, server chip)
 * comes from `:app`; apply [contentPadding] to the scrolling container. Stub: Agent A1 builds it.
 */
@Composable
fun OverviewScreen(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    val navigator = LocalNavigator.current
    PlaceholderSection(
        title = "Overview",
        contentPadding = contentPadding,
        modifier = modifier,
        samples = listOf(TaskDetailRoute("sample-task"), AgentDetailRoute("sample-agent", compose = true)),
        extra = {
            OutlinedButton(onClick = { navigator.open(Section.MACHINES) }, modifier = Modifier.testTag("open-machines")) {
                Text("Open Library › Machines")
            }
            OutlinedButton(onClick = { navigator.open(Section.WORK, WorkView.RECURRING) }, modifier = Modifier.testTag("open-recurring")) {
                Text("Open Work › Recurring")
            }
        },
    )
}
