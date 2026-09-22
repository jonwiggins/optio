package dev.optio.feature.reviews

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.optio.core.navigation.routes.NewWorkRoute
import dev.optio.core.navigation.routes.ReviewDetailRoute
import dev.optio.core.ui.PlaceholderSection

/** Work › Reviews (iOS `ReviewsListView`). Stub: Agent A4 builds it. */
@Composable
fun ReviewsSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    PlaceholderSection(
        title = "Reviews",
        contentPadding = contentPadding,
        modifier = modifier,
        samples = listOf(ReviewDetailRoute("sample-review")),
    )
}

/** Work › Inbox: the GitHub issues queue (iOS `IssuesListView`). Stub: Agent A4 builds it. */
@Composable
fun InboxSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    PlaceholderSection(
        title = "Inbox",
        contentPadding = contentPadding,
        modifier = modifier,
        samples = listOf(NewWorkRoute(preset = "issue")),
    )
}
