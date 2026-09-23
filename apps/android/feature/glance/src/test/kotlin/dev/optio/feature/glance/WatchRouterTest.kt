package dev.optio.feature.glance

import dev.optio.core.navigation.AppRouter
import dev.optio.core.navigation.Tab
import dev.optio.core.navigation.WorkView
import dev.optio.core.navigation.routes.HubRoute
import dev.optio.core.navigation.routes.NewWorkRoute
import dev.optio.core.navigation.routes.WatchSettingsRoute
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The router half of iOS `WatchSessionsTests` (`testRouterOpensNewWorkSheetAndViews`): the links
 * the glanceable surfaces fire land where iOS lands them. Android pushes the New work form onto the
 * Work tab instead of raising a sheet.
 */
class WatchRouterTest {
    @Test
    fun routerOpensNewWorkAndViews() {
        val router = AppRouter()
        assertTrue(router.handle("optio://work/new"))
        assertEquals(Tab.WORK, router.selectedTab)
        assertEquals(listOf(HubRoute(Tab.WORK), NewWorkRoute()), router.backStack(Tab.WORK).toList())

        assertTrue(router.handle("optio://section/sessions?view=recurring"))
        assertEquals(WorkView.RECURRING, router.pendingWorkView)
        assertTrue(router.handle("optio://section/sessions?view=bogus"))
        assertEquals(WorkView.ACTIVE, router.pendingWorkView, "unknown views fall back to Active")
        router.pendingWorkView = null
        assertTrue(router.handle("optio://needs-you"), "the Watch's fallback link")
        assertEquals(WorkView.ACTIVE, router.pendingWorkView)
    }

    @Test
    fun watchSettingsRouteSurvivesBackStackSaving() {
        val encoded = AppRouter.encodeBackStack(listOf(HubRoute(Tab.MORE), WatchSettingsRoute))
        assertEquals(listOf(HubRoute(Tab.MORE), WatchSettingsRoute), AppRouter.decodeBackStack(encoded))
    }
}
