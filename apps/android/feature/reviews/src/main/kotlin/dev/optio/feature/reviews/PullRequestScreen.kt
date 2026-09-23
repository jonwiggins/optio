package dev.optio.feature.reviews

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.PullRequestRoute
import dev.optio.core.navigation.routes.ReviewDetailRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.StatusBadge
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

/** Launches the first review of a PR (iOS `PullRequestSummaryView`'s state). */
internal class PullRequestViewModel(private val api: ApiClient) : ViewModel() {
    private val _launching = MutableStateFlow(false)
    val launching: StateFlow<Boolean> = _launching.asStateFlow()

    private val _error = MutableStateFlow<Throwable?>(null)
    val error: StateFlow<Throwable?> = _error.asStateFlow()

    private val _opened = Channel<String>(Channel.BUFFERED)

    /** Ids of reviews to open. */
    val opened: Flow<String> = _opened.receiveAsFlow()

    fun launch(prUrl: String) {
        if (_launching.value) return
        viewModelScope.launch {
            _launching.value = true
            try {
                val review = api.createPrReview(prUrl)
                _error.value = null
                _opened.send(review.id)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                _error.value = e
            } finally {
                _launching.value = false
            }
        }
    }
}

/** A PR without an Optio review: its facts, "Review with Optio" and the host link. */
@Composable
internal fun PullRequestScreen(route: PullRequestRoute) {
    val api = LocalApiClient.current
    val navigator = LocalNavigator.current
    val model = viewModel(key = "pull-request-${route.url}") { PullRequestViewModel(api) }
    val launching by model.launching.collectAsStateWithLifecycle()
    val error by model.error.collectAsStateWithLifecycle()
    LaunchedEffect(model) { model.opened.collect { id -> navigator.push(ReviewDetailRoute(id)) } }
    PullRequestContent(
        route = route,
        launching = launching,
        error = error,
        canMutate = Roles.canMutate,
        onBack = navigator::pop,
        onReview = { model.launch(route.url) },
        onOpenExternal = { navigator.openExternal(route.url) },
    )
}

@Composable
internal fun PullRequestContent(
    route: PullRequestRoute,
    launching: Boolean,
    error: Throwable?,
    canMutate: Boolean,
    onBack: () -> Unit = {},
    onReview: () -> Unit = {},
    onOpenExternal: () -> Unit = {},
) {
    val now = rememberNow()
    Scaffold(
        modifier = Modifier.testTag("pull-request-screen"),
        containerColor = OptioTheme.colors.page,
        topBar = {
            TopAppBar(
                title = { Text("PR #${route.number}") },
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.testTag("back")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().readableWidth(),
            contentPadding = PaddingValues(top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding() + Spacing.xl),
        ) {
            item {
                GroupedSection(modifier = Modifier.padding(top = Spacing.s)) {
                    Text(
                        route.title,
                        style = OptioTheme.type.body,
                        color = OptioTheme.colors.label,
                        modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m),
                    )
                    route.repo?.let {
                        InsetDivider()
                        KeyValueRow("Repo", it)
                    }
                    route.author?.let {
                        InsetDivider()
                        KeyValueRow("Author", it)
                    }
                    ReviewDates.parse(route.updatedAt)?.let {
                        InsetDivider()
                        KeyValueRow("Updated", it.relativeDescription(now))
                    }
                    if (route.draft) {
                        InsetDivider()
                        KeyValueRow("State", null, trailing = { StatusBadge(text = "Draft", tone = Tone.IDLE) })
                    }
                    InsetDivider()
                    KeyValueRow(
                        label = "Open on ${platformName(route.url)}",
                        value = null,
                        onClick = onOpenExternal,
                        modifier = Modifier.testTag("open-external"), trailing = {
                        Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null, tint = OptioTheme.colors.accent, modifier = Modifier.size(18.dp))
                    })
                }
            }
            route.labels?.let { labels ->
                item {
                    GroupedSection(header = "Labels") {
                        Text(
                            labels,
                            style = OptioTheme.type.footnote,
                            color = OptioTheme.colors.secondaryLabel,
                            modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m),
                        )
                    }
                }
            }
            if (canMutate) {
                item {
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.xl),
                        verticalArrangement = Arrangement.spacedBy(Spacing.s),
                    ) {
                        Button(
                            onClick = onReview,
                            enabled = !launching,
                            modifier = Modifier.fillMaxWidth().testTag("review-with-optio"),
                        ) {
                            if (launching) {
                                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                            } else {
                                Icon(Icons.Outlined.Visibility, contentDescription = null, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.width(Spacing.s))
                                Text("Review with Optio")
                            }
                        }
                        if (error != null) ErrorRow(error = error, contentPadding = PaddingValues(0.dp))
                    }
                }
            }
        }
    }
}
