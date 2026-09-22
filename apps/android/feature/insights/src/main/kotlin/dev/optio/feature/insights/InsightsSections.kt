package dev.optio.feature.insights

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.optio.core.navigation.routes.PodDetailRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.ui.PlaceholderSection

/** Insights › Analytics (iOS `Features/Insights`). Stub: Agent A4 builds it. */
@Composable
fun AnalyticsSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    PlaceholderSection("Analytics", contentPadding, modifier, samples = listOf(TaskDetailRoute("sample-task")))
}

/** Insights › Costs. Stub: Agent A4 builds it. */
@Composable
fun CostsSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    PlaceholderSection("Costs", contentPadding, modifier, samples = listOf(TaskDetailRoute("sample-task")))
}

/** Insights › Activity. Stub: Agent A4 builds it. */
@Composable
fun ActivitySection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    PlaceholderSection("Activity", contentPadding, modifier, samples = listOf(TaskDetailRoute("sample-task")))
}

/** Insights › Cluster. Stub: Agent A4 builds it. */
@Composable
fun ClusterSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    PlaceholderSection("Cluster", contentPadding, modifier, samples = listOf(PodDetailRoute("sample-pod")))
}
