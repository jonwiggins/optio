package dev.optio.feature.sessions

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import dev.optio.core.model.SessionPr
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.PullRefresh
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone

/** PRs the session opened (iOS `prList`); a row opens the PR in the browser. */
@Composable
internal fun SessionPrList(
    prs: List<SessionPr>,
    onRefresh: suspend () -> Unit,
    onOpen: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    PullRefresh(onRefresh = onRefresh, modifier = modifier) {
        LazyColumn(Modifier.fillMaxSize().testTag("session-prs")) {
            if (prs.isEmpty()) {
                item {
                    Text(
                        "No PRs opened during this session yet. PR URLs printed in the terminal are picked up automatically.",
                        style = OptioTheme.type.footnote,
                        color = OptioTheme.colors.secondaryLabel,
                        modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m),
                    )
                }
            }
            itemsIndexed(prs, key = { _, pr -> pr.id }) { index, pr ->
                SessionPrRow(pr, onOpen = { onOpen(pr.prUrl) })
                if (index < prs.lastIndex) InsetDivider()
            }
        }
    }
}

/** "PR #77 · open · CI pending · review none · Open ↗" (iOS). An open PR carries no dot. */
@Composable
internal fun SessionPrRow(
    pr: SessionPr,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tone = Tone.forState(pr.prState ?: "open")
    OptioRow(
        title = "PR #${pr.prNumber.toInt()}",
        tone = if (tone == Tone.WORKING) null else tone,
        meta =
            metaText(
                pr.prState,
                pr.prChecksStatus?.let { "CI ${it.replace('_', ' ')}" },
                pr.prReviewStatus?.let { "review ${it.replace('_', ' ')}" },
            ),
        trailing = "Open ↗",
        titleMaxLines = 1,
        onClick = onOpen,
        onClickLabel = "Open pull request",
        modifier = modifier.testTag("pr-${pr.prNumber.toInt()}"),
    )
}
