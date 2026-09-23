package dev.optio.app.shell

import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.LocalContentColor
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.navigation.LocalAppRouter
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.Tab
import dev.optio.core.ui.hub.LocalHubController
import dev.optio.core.ui.hub.rememberHubController
import dev.optio.feature.insights.ActivitySection
import dev.optio.feature.insights.AnalyticsSection
import dev.optio.feature.insights.ClusterSection
import dev.optio.feature.insights.CostsSection
import dev.optio.feature.library.ConnectionsSection
import dev.optio.feature.library.PromptsSection
import dev.optio.feature.library.ReposSection
import dev.optio.feature.local.MachinesSection
import dev.optio.feature.more.MoreScreen
import dev.optio.feature.overview.OverviewScreen
import dev.optio.feature.reviews.InboxSection
import dev.optio.feature.reviews.ReviewsSection
import dev.optio.feature.work.WorkListSection

/**
 * A tab's hub: the root entry of its back stack (`HubRoute(tab)`). Chrome: a top app bar with the
 * tab's title, the server switcher (always on Overview; on the other hubs when more than one
 * server is paired) and the section's actions, the segmented section switcher (Work, Library,
 * Insights), and the section's FAB, all contributed through the hub slot API
 * (`dev.optio.core.ui.hub`). The body is the selected section's composable from its feature.
 */
@Composable
internal fun HubScreen(tab: Tab) {
    val router = LocalAppRouter.current
    val controller = rememberHubController()
    val section = router.section(tab)
    val multipleServers by LocalSessionStore.current.hasMultipleServers.collectAsStateWithLifecycle()
    val showSwitcher = tab == Tab.OVERVIEW || multipleServers
    Scaffold(
        modifier = Modifier.testTag("hub-${tab.name.lowercase()}"),
        topBar = {
            // One opaque bar: the switcher row sits under the app bar's container colour, so a
            // list scrolled beneath it never shows through the segmented buttons.
            Column(Modifier.background(TopAppBarDefaults.topAppBarColors().containerColor)) {
                TopAppBar(
                    title = { Text(tab.label) },
                    actions = {
                        if (showSwitcher) HubServerSwitcher()
                        controller.actions?.invoke(this)
                    },
                )
                if (section != null) {
                    HubSwitcher(sections = tab.sections, selected = section, onSelect = router::selectSection)
                }
            }
        },
        floatingActionButton = { controller.fab?.invoke() },
    ) { padding ->
        CompositionLocalProvider(LocalHubController provides controller) {
            HubContent(tab = tab, section = section, contentPadding = padding)
        }
    }
}

/** Maps a hub (and its selected section) to the feature composable that draws it. */
@Composable
private fun HubContent(
    tab: Tab,
    section: Section?,
    contentPadding: PaddingValues,
) {
    when (tab) {
        Tab.OVERVIEW -> OverviewScreen(contentPadding)
        Tab.MORE -> MoreScreen(contentPadding)
        Tab.WORK, Tab.LIBRARY, Tab.INSIGHTS ->
            when (section) {
                Section.WORK -> WorkListSection(contentPadding)
                Section.REVIEWS -> ReviewsSection(contentPadding)
                Section.INBOX -> InboxSection(contentPadding)
                Section.PROMPTS -> PromptsSection(contentPadding)
                Section.REPOS -> ReposSection(contentPadding)
                Section.MACHINES -> MachinesSection(contentPadding)
                Section.CONNECTIONS -> ConnectionsSection(contentPadding)
                Section.ANALYTICS -> AnalyticsSection(contentPadding)
                Section.COSTS -> CostsSection(contentPadding)
                Section.ACTIVITY -> ActivitySection(contentPadding)
                Section.CLUSTER -> ClusterSection(contentPadding)
                null -> Unit
            }
    }
}

/** The hub's section switcher (iOS `HubSwitcher`: a segmented control under the title). */
@Composable
private fun HubSwitcher(
    sections: List<Section>,
    selected: Section,
    onSelect: (Section) -> Unit,
) {
    SingleChoiceSegmentedButtonRow(
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
    ) {
        sections.forEachIndexed { index, section ->
            SegmentedButton(
                selected = section == selected,
                onClick = { onSelect(section) },
                shape = SegmentedButtonDefaults.itemShape(index = index, count = sections.size),
                icon = {},
                modifier = Modifier.testTag("section-${section.name.lowercase()}"),
                // Four segments ("Connections") don't fit a phone at the label size: shrink to fit
                // rather than truncate. The floor is in dp, not sp: an sp floor grows with the
                // font scale (at 1.3 "Connections" still didn't fit and was clipped mid-word).
                // Past the floor (very large font scales) the label ends in an ellipsis.
                label = {
                    val style = LocalTextStyle.current
                    val floor = with(LocalDensity.current) { HUB_LABEL_MIN.toSp() }
                    BasicText(
                        section.label,
                        style = style.copy(color = LocalContentColor.current),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        autoSize = TextAutoSize.StepBased(minFontSize = floor, maxFontSize = style.fontSize),
                    )
                },
            )
        }
    }
}

/** The smallest a hub segment label shrinks to (in dp, so it holds at every font scale). */
private val HUB_LABEL_MIN = 9.dp
