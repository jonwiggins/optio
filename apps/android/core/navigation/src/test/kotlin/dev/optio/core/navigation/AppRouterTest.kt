package dev.optio.core.navigation

import androidx.compose.runtime.saveable.SaverScope
import dev.optio.core.navigation.routes.HubRoute
import dev.optio.core.navigation.routes.PodDetailRoute
import dev.optio.core.navigation.routes.RepoDetailRoute
import dev.optio.core.navigation.routes.SettingsRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AppRouterTest {
    @Test
    fun startsOnOverviewWithEachTabAtItsHub() {
        val router = AppRouter()
        assertEquals(Tab.OVERVIEW, router.selectedTab)
        Tab.entries.forEach { tab -> assertEquals(listOf(HubRoute(tab)), router.backStack(tab).toList()) }
        assertEquals(Section.WORK, router.section(Tab.WORK))
        assertEquals(Section.PROMPTS, router.section(Tab.LIBRARY))
        assertNull(router.section(Tab.MORE))
    }

    @Test
    fun pushAndPopActOnTheSelectedTab() {
        val router = AppRouter()
        router.select(Tab.WORK)
        router.push(TaskDetailRoute("t1"))
        assertEquals(listOf(HubRoute(Tab.WORK), TaskDetailRoute("t1")), router.currentBackStack.toList())
        assertEquals(listOf(HubRoute(Tab.OVERVIEW)), router.backStack(Tab.OVERVIEW).toList())

        assertTrue(router.pop())
        assertFalse(router.pop(), "the hub is never popped")
        assertEquals(listOf(HubRoute(Tab.WORK)), router.currentBackStack.toList())
    }

    @Test
    fun switchingTabsKeepsEachStack() {
        val router = AppRouter()
        router.select(Tab.WORK)
        router.push(TaskDetailRoute("t1"))
        router.select(Tab.LIBRARY)
        router.push(RepoDetailRoute("r1"))
        router.select(Tab.WORK)
        assertEquals(TaskDetailRoute("t1"), router.currentBackStack.last())
        assertEquals(RepoDetailRoute("r1"), router.backStack(Tab.LIBRARY).last())
    }

    @Test
    fun reselectingTheSelectedTabPopsToItsHub() {
        val router = AppRouter()
        router.select(Tab.MORE)
        router.push(SettingsRoute)
        router.push(TaskDetailRoute("t1"))
        router.select(Tab.MORE)
        assertEquals(Tab.MORE, router.selectedTab)
        assertEquals(listOf(HubRoute(Tab.MORE)), router.currentBackStack.toList())
    }

    @Test
    fun openSwitchesToTheOwningTabSelectsTheSectionAndShowsTheHub() {
        val router = AppRouter()
        router.push(RepoDetailRoute("r1"), tab = Tab.LIBRARY)
        router.open(Section.MACHINES)
        assertEquals(Tab.LIBRARY, router.selectedTab)
        assertEquals(Section.MACHINES, router.section(Tab.LIBRARY))
        assertEquals(listOf(HubRoute(Tab.LIBRARY)), router.currentBackStack.toList())

        router.openWork(WorkView.RECURRING)
        assertEquals(Tab.WORK, router.selectedTab)
        assertEquals(Section.WORK, router.section(Tab.WORK))
        assertEquals(WorkView.RECURRING, router.pendingWorkView)
    }

    @Test
    fun selectSectionStaysOnTheCurrentTab() {
        val router = AppRouter()
        router.select(Tab.INSIGHTS)
        router.selectSection(Section.CLUSTER)
        assertEquals(Section.CLUSTER, router.section(Tab.INSIGHTS))
        assertEquals(Tab.INSIGHTS, router.selectedTab)
    }

    @Test
    fun saverRestoresTabSectionsAndStacks() {
        val router = AppRouter()
        router.open(Section.CLUSTER)
        router.push(PodDetailRoute("p1"))
        router.push(TaskDetailRoute("t1"), tab = Tab.WORK)
        router.selectSection(Section.REVIEWS)

        val saved = with(AppRouter.Saver) { SaverScope { true }.save(router) }
        val restored = assertNotNull(AppRouter.Saver.restore(assertNotNull(saved)))

        assertEquals(Tab.INSIGHTS, restored.selectedTab)
        assertEquals(Section.CLUSTER, restored.section(Tab.INSIGHTS))
        assertEquals(Section.REVIEWS, restored.section(Tab.WORK))
        Tab.entries.forEach { tab -> assertEquals(router.backStack(tab).toList(), restored.backStack(tab).toList()) }
    }
}
