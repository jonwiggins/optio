package dev.optio.feature.reviews

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.IssueDetailRoute
import dev.optio.core.navigation.routes.PullRequestRoute
import dev.optio.core.navigation.routes.ReviewDetailRoute

/** Registers `:feature:reviews`'s screens: a review, a PR without one, and an Inbox issue. */
fun EntryProviderScope<NavKey>.reviewsEntries() {
    entry<ReviewDetailRoute> { key -> ReviewDetailScreen(reviewId = key.id) }
    entry<PullRequestRoute> { key -> PullRequestScreen(route = key) }
    entry<IssueDetailRoute> { key -> IssueDetailScreen(route = key) }
}
