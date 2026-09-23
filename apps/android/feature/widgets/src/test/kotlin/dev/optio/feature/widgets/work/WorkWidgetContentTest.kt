package dev.optio.feature.widgets.work

import android.content.Context
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.action.actionParametersOf
import androidx.glance.appwidget.testing.unit.GlanceAppWidgetUnitTest
import androidx.glance.appwidget.testing.unit.hasRunCallbackClickAction
import androidx.glance.appwidget.testing.unit.runGlanceAppWidgetUnitTest
import androidx.glance.testing.unit.assertHasClickAction
import androidx.glance.testing.unit.assertHasContentDescription
import androidx.glance.testing.unit.assertHasText
import androidx.glance.testing.unit.hasContentDescription
import androidx.glance.testing.unit.hasTestTag
import androidx.glance.testing.unit.hasText
import androidx.glance.testing.unit.hasTextEqualTo
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.optio.feature.widgets.model.GlanceEntry
import java.time.Instant
import java.util.TimeZone
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * What each Work widget size shows (iOS `WorkWidgetView` previews), asserted on the Glance tree:
 * counts, tiles, rows within the budget, chips, Later, server labels and the honesty footer.
 */
@RunWith(AndroidJUnit4::class)
class WorkWidgetContentTest {
    private val now: Instant = Instant.parse("2026-09-22T16:40:00Z")
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Before
    fun utc() {
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    }

    private fun render(
        entry: GlanceEntry,
        family: WorkFamily,
        checks: GlanceAppWidgetUnitTest.() -> Unit,
    ) = runGlanceAppWidgetUnitTest {
        setContext(context)
        setAppWidgetSize(
            when (family) {
                WorkFamily.SMALL -> DpSize(170.dp, 170.dp)
                WorkFamily.MEDIUM -> DpSize(360.dp, 170.dp)
                WorkFamily.LARGE -> DpSize(360.dp, 380.dp)
            },
        )
        provideComposable { WorkWidgetContent(entry, family) }
        checks()
    }

    @Test
    fun familiesFollowTheSize() {
        kotlin.test.assertEquals(WorkFamily.SMALL, WorkFamily.forSize(DpSize(170.dp, 170.dp)))
        kotlin.test.assertEquals(WorkFamily.SMALL, WorkFamily.forSize(DpSize(170.dp, 400.dp)))
        kotlin.test.assertEquals(WorkFamily.MEDIUM, WorkFamily.forSize(DpSize(360.dp, 170.dp)))
        kotlin.test.assertEquals(WorkFamily.LARGE, WorkFamily.forSize(DpSize(360.dp, 380.dp)))
    }

    @Test
    fun smallShowsTheNumberThatMattersAndTheHead() =
        render(WidgetSamples.waiting(now), WorkFamily.SMALL) {
            onNode(hasTestTag("work-headline")).assertHasText("3")
            onNode(hasText("need you")).assertExists()
            onNode(hasText("2 servers")).assertExists()
            onNode(hasText("Vesper")).assertExists()
            onNode(hasText("@vesper")).assertExists()
            onNode(hasContentDescription("on Studio")).assertExists()
        }

    @Test
    fun smallRunningAndQuiet() {
        render(WidgetSamples.quiet(now), WorkFamily.SMALL) {
            onNode(hasTestTag("work-headline")).assertHasText("3")
            onNode(hasText("running")).assertExists()
        }
        render(WidgetSamples.idle(now), WorkFamily.SMALL) {
            onNode(hasTestTag("work-headline")).assertHasText("Quiet")
            onNode(hasText("no sessions running")).assertExists()
        }
    }

    @Test
    fun smallNamesItsServerWhenOthersArePaired() =
        render(WidgetSamples.one(now), WorkFamily.SMALL) {
            onNode(hasTextEqualTo("MacBook Pro")).assertExists()
            onNode(hasTestTag("work-headline")).assertHasText("1")
            onNode(hasText("needs you")).assertExists()
            onNode(hasText("MacBook Pro · web")).assertExists()
        }

    @Test
    fun mediumShowsTheHeaderTilesAndTwoRows() =
        render(WidgetSamples.waiting(now), WorkFamily.MEDIUM) {
            onNode(hasText(" need you")).assertExists()
            onNode(hasText(" running")).assertExists()
            onNode(hasTestTag("work-tile-needs_you")).assertHasContentDescription("3 Need you")
            onNode(hasTestTag("work-tile-recurring")).assertHasContentDescription("8 Recurring")
            onNode(hasTestTag("work-tile-agents")).assertHasClickAction()
            onNode(hasTestTag("work-row-a-vesper")).assertExists().assertHasClickAction()
            onNode(hasTestTag("work-row-t-api")).assertExists()
            onNode(hasTestTag("work-row-t-web")).assertDoesNotExist()
            onNode(hasTestTag("work-overflow")).assertHasText("+5 more")
            onNode(hasText("Failed")).assertExists()
            onNode(hasText("Reply")).assertExists()
            onNode(hasText("38m")).assertExists()
            onNode(hasTestTag("work-later-t-api")).assertDoesNotExist()
        }

    @Test
    fun largeShowsSixTwoLineRowsWithLater() =
        render(WidgetSamples.waiting(now), WorkFamily.LARGE) {
            for (id in listOf("a-vesper", "t-api", "t-web", "t-docs", "task-2", "t-cli")) onNode(hasTestTag("work-row-$id")).assertExists()
            onNode(hasTestTag("work-row-task-1")).assertDoesNotExist()
            onNode(hasTestTag("work-overflow")).assertHasText("+1 more")
            onNode(hasTestTag("work-later-t-api")).assertExists()
            onNode(hasTestTag("work-later-t-web")).assertExists()
            onNode(hasTestTag("work-later-a-vesper")).assertDoesNotExist()
            onNode(
                hasRunCallbackClickAction<LaterAction>(
                    actionParametersOf(LaterAction.itemId to "t-web", LaterAction.kind to "local", LaterAction.serverId to "srv-laptop"),
                ),
            ).assertExists()
            onNode(hasText("messages")).assertExists()
            onNode(hasText("persistent")).assertExists()
            onAllNodes(hasText("Codex")).assertCountEquals(2)
            onNode(hasText("Allow?")).assertExists()
            onNode(hasText("feat/ios-widgets")).assertExists()
        }

    @Test
    fun olderServersShowTwoTiles() =
        render(WidgetSamples.legacy(now), WorkFamily.MEDIUM) {
            onNode(hasTestTag("work-tile-needs_you")).assertExists()
            onNode(hasTestTag("work-tile-running")).assertExists()
            onNode(hasTestTag("work-tile-waiting")).assertDoesNotExist()
            onNode(hasTestTag("work-tile-agents")).assertDoesNotExist()
        }

    @Test
    fun emptyBoards() {
        render(WidgetSamples.idle(now), WorkFamily.MEDIUM) {
            onNode(hasTestTag("work-empty")).assertHasText("No sessions running")
            onNode(hasText("Quiet")).assertExists()
        }
    }

    @Test
    fun honestyFooters() {
        render(WidgetSamples.offline(now), WorkFamily.MEDIUM) {
            onNode(hasContentDescription("unreachable since 3:59 PM")).assertExists()
            onNode(hasTestTag("work-footer")).assertHasText("3:59 PM")
        }
        render(WidgetSamples.partial(now), WorkFamily.SMALL) {
            onNode(hasTestTag("work-footer")).assertHasContentDescription("Studio unreachable")
        }
        render(WidgetSamples.stale(now), WorkFamily.MEDIUM) {
            onNode(hasTestTag("work-footer")).assertHasText("as of 4:05 PM")
        }
        render(WidgetSamples.single(now), WorkFamily.MEDIUM) {
            onNode(hasTestTag("work-footer")).assertDoesNotExist()
        }
    }

    @Test
    fun signedOut() {
        for (family in WorkFamily.entries) {
            render(WidgetSamples.signedOut(now), family) {
                onNode(hasTestTag("signed-out")).assertHasText("Sign in to Optio")
                onNode(hasTestTag("signed-out-body")).assertHasClickAction()
            }
        }
    }
}
