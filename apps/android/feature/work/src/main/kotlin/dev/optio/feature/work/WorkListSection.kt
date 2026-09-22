package dev.optio.feature.work

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.AgentDetailRoute
import dev.optio.core.navigation.routes.JobRunRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.navigation.routes.NewWorkRoute
import dev.optio.core.navigation.routes.SessionDetailRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.ui.PlaceholderSection
import dev.optio.core.ui.hub.HubFab

/**
 * Work › All: the merged Work feed (iOS `WorkListView`). Stub: Agent A1 builds it.
 * Demonstrates the hub slot API with a "New work" FAB.
 */
@Composable
fun WorkListSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    val navigator = LocalNavigator.current
    HubFab {
        ExtendedFloatingActionButton(
            onClick = { navigator.push(NewWorkRoute()) },
            icon = { Icon(Icons.Filled.Add, contentDescription = null) },
            text = { Text("New work") },
            modifier = Modifier.testTag("new-work"),
        )
    }
    PlaceholderSection(
        title = "Work",
        contentPadding = contentPadding,
        modifier = modifier,
        samples =
            listOf(
                TaskDetailRoute("sample-task"),
                JobRunRoute(jobId = "sample-job", runId = "sample-run"),
                LocalTerminalRoute("sample-terminal"),
                AgentDetailRoute("sample-agent"),
                SessionDetailRoute("sample-session"),
            ),
    )
}
