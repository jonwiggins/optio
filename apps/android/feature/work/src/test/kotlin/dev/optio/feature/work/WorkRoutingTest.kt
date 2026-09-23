package dev.optio.feature.work

import dev.optio.core.navigation.AppRouter
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.Tab
import dev.optio.core.navigation.WorkView
import dev.optio.core.navigation.routes.HubRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * iOS `WorkFeedTests.testLegacySectionNamesLandOnSessionsViews`: every old per-kind list is a view
 * of the one Work list, and deep links park the view for [WorkListSection] to pick up. Android's
 * router pushes details straight onto the Work tab (iOS parks them in `pendingDetail`).
 */
class WorkRoutingTest {
    @Test
    fun legacySectionNamesLandOnWorkViews() {
        assertEquals(Section.WORK, AppRouter.section("tasks")?.first)
        assertEquals(WorkView.ALL, AppRouter.section("tasks")?.second)
        assertEquals(WorkView.RECURRING, AppRouter.section("jobs")?.second)
        assertEquals(WorkView.RECURRING, AppRouter.section("scheduled")?.second)
        assertEquals(WorkView.AGENTS, AppRouter.section("agents")?.second)
        assertEquals(WorkView.ACTIVE, AppRouter.section("local")?.second)
        assertEquals(Section.WORK, AppRouter.section("sessions")?.first)
        assertNull(AppRouter.section("sessions")?.second)
        assertEquals(Section.INBOX, AppRouter.section("issues")?.first)
        assertEquals(Section.MACHINES, AppRouter.section("machines")?.first)
        assertNull(AppRouter.section("nope"))
    }

    @Test
    fun deepLinksParkTheViewForTheWorkList() {
        val router = AppRouter()
        assertTrue(router.handle("optio://section/sessions?view=recurring"))
        assertEquals(Tab.WORK, router.selectedTab)
        assertEquals(Section.WORK, router.section(Tab.WORK))
        assertEquals(WorkView.RECURRING, router.pendingWorkView)

        assertTrue(router.handle("optio://section/work?view=history"))
        assertEquals(WorkView.HISTORY, router.pendingWorkView)

        assertTrue(router.handle("optio://tasks/abc"))
        assertEquals(listOf(HubRoute(Tab.WORK), TaskDetailRoute("abc")), router.backStack(Tab.WORK).toList())

        assertTrue(router.handle("optio://needs-you"))
        assertEquals(WorkView.ACTIVE, router.pendingWorkView)
        assertEquals(listOf(HubRoute(Tab.WORK)), router.backStack(Tab.WORK).toList(), "the Work tab pops to its list")
    }
}
