package dev.optio.core.navigation

import androidx.navigation3.runtime.NavKey
import dev.optio.core.data.DeepLink
import dev.optio.core.navigation.routes.AgentDetailRoute
import dev.optio.core.navigation.routes.EditWorkRoute
import dev.optio.core.navigation.routes.HubRoute
import dev.optio.core.navigation.routes.JobRunRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.navigation.routes.NewWorkRoute
import dev.optio.core.navigation.routes.RepoDetailRoute
import dev.optio.core.navigation.routes.SessionDetailRoute
import dev.optio.core.navigation.routes.SettingsRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Every deep link and legacy section name → where the router lands (iOS `AppRouter.handle(url:)`). */
class AppRouterDeepLinkTest {
    private fun AppRouter.stack(tab: Tab): List<NavKey> = backStack(tab).toList()

    @Test
    fun detailsLandOnTheWorkTabInOneHop() {
        val cases =
            mapOf(
                "optio://tasks/t1" to TaskDetailRoute("t1"),
                "optio://local/lt1" to LocalTerminalRoute("lt1"),
                "optio://local/lt1?compose=1" to LocalTerminalRoute("lt1", compose = true),
                "optio://agents/a1?compose=1" to AgentDetailRoute("a1", compose = true),
                "optio://agents/a1" to AgentDetailRoute("a1"),
                "optio://sessions/s1" to SessionDetailRoute("s1"),
                "optio://local/lt1?compose=1&server=dev-server_2" to LocalTerminalRoute("lt1", compose = true),
            )
        cases.forEach { (url, route) ->
            val router = AppRouter()
            // Something already open on Work and elsewhere.
            router.push(JobRunRoute("j", "r"), Tab.WORK)
            router.selectSection(Section.INBOX)
            router.select(Tab.LIBRARY)
            router.push(RepoDetailRoute("r1"))

            assertTrue(router.handle(url), url)
            assertEquals(Tab.WORK, router.selectedTab, url)
            assertEquals(Section.WORK, router.section(Tab.WORK), url)
            assertEquals(listOf(HubRoute(Tab.WORK), route), router.stack(Tab.WORK), url)
            assertEquals(listOf(HubRoute(Tab.LIBRARY), RepoDetailRoute("r1")), router.stack(Tab.LIBRARY), "other tabs keep their stacks")
        }
    }

    @Test
    fun needsYouAndWorkViewsOpenTheWorkList() {
        val router = AppRouter()
        assertTrue(router.handle("optio://needs-you"))
        assertEquals(Tab.WORK, router.selectedTab)
        assertEquals(WorkView.ACTIVE, router.pendingWorkView)
        assertEquals(listOf(HubRoute(Tab.WORK)), router.stack(Tab.WORK))

        WorkView.entries.forEach { view ->
            router.pendingWorkView = null
            assertTrue(router.handle(DeepLink.Work(view.raw)))
            assertEquals(view, router.pendingWorkView)
        }
        router.pendingWorkView = null
        assertTrue(router.handle("optio://section/sessions?view=history"))
        assertEquals(WorkView.HISTORY, router.pendingWorkView, "legacy section/sessions?view=")
        router.pendingWorkView = null
        assertTrue(router.handle("optio://section/work?view=nonsense"))
        assertEquals(WorkView.ACTIVE, router.pendingWorkView, "an unknown view falls back to Active")
    }

    @Test
    fun newWorkPushesTheForm() {
        listOf("optio://work/new", "optio://sessions/new").forEach { url ->
            val router = AppRouter()
            assertTrue(router.handle(url))
            assertEquals(Tab.WORK, router.selectedTab)
            assertEquals(listOf(HubRoute(Tab.WORK), NewWorkRoute()), router.stack(Tab.WORK), url)
        }
    }

    @Test
    fun everySectionNameIncludingLegacyOnes() {
        val expected: Map<String, Pair<Section, WorkView?>> =
            mapOf(
                "work" to (Section.WORK to null),
                "sessions" to (Section.WORK to null),
                "tasks" to (Section.WORK to WorkView.ALL),
                "jobs" to (Section.WORK to WorkView.RECURRING),
                "scheduled" to (Section.WORK to WorkView.RECURRING),
                "agents" to (Section.WORK to WorkView.AGENTS),
                "local" to (Section.WORK to WorkView.ACTIVE),
                "reviews" to (Section.REVIEWS to null),
                "issues" to (Section.INBOX to null),
                "inbox" to (Section.INBOX to null),
                "prompts" to (Section.PROMPTS to null),
                "templates" to (Section.PROMPTS to null),
                "repos" to (Section.REPOS to null),
                "machines" to (Section.MACHINES to null),
                "hosts" to (Section.MACHINES to null),
                "connections" to (Section.CONNECTIONS to null),
                "analytics" to (Section.ANALYTICS to null),
                "costs" to (Section.COSTS to null),
                "activity" to (Section.ACTIVITY to null),
                "cluster" to (Section.CLUSTER to null),
            )
        expected.forEach { (name, target) ->
            assertEquals(target, AppRouter.section(named = name), name)
            val router = AppRouter()
            router.push(RepoDetailRoute("r1"), Tab.LIBRARY)
            assertTrue(router.handle("optio://section/$name"), name)
            val (section, view) = target
            assertEquals(section.tab, router.selectedTab, name)
            assertEquals(section, router.section(section.tab), name)
            assertEquals(listOf(HubRoute(section.tab)), router.stack(section.tab), "$name shows the hub")
            assertEquals(view, router.pendingWorkView, name)
        }
        assertNull(AppRouter.section(named = "more"))
        assertNull(AppRouter.section(named = "nope"))
    }

    @Test
    fun anExplicitViewOverridesALegacySectionsView() {
        val router = AppRouter()
        assertTrue(router.handle("optio://section/tasks?view=recurring"))
        assertEquals(WorkView.RECURRING, router.pendingWorkView)
        router.pendingWorkView = null
        assertTrue(router.handle("optio://section/tasks?view=bogus"))
        assertEquals(WorkView.ALL, router.pendingWorkView, "an unknown explicit view keeps the section's own")
    }

    @Test
    fun moreSelectsTheMoreTab() {
        val router = AppRouter()
        router.push(SettingsRoute, Tab.MORE)
        assertTrue(router.handle("optio://section/more"))
        assertEquals(Tab.MORE, router.selectedTab)
        assertEquals(listOf(HubRoute(Tab.MORE)), router.stack(Tab.MORE))
    }

    @Test
    fun unknownLinksAreRefusedAndChangeNothing() {
        val router = AppRouter()
        router.push(RepoDetailRoute("r1"), Tab.LIBRARY)
        listOf("optio://section/bogus", "optio://unknown/x", "https://example.com", "optio://tasks").forEach { url ->
            assertFalse(router.handle(url), url)
        }
        assertEquals(Tab.OVERVIEW, router.selectedTab)
        assertEquals(listOf(HubRoute(Tab.LIBRARY), RepoDetailRoute("r1")), router.stack(Tab.LIBRARY))
        assertNull(router.pendingWorkView)
    }

    @Test
    fun showCreatedWorkClosesTheFormAndLandsOnTheDetail() {
        // The form opened from Overview.
        val router = AppRouter()
        router.push(NewWorkRoute())
        router.showCreatedWork(TaskDetailRoute("t9"), toast = "Started Fix login")
        assertEquals(Tab.WORK, router.selectedTab)
        assertEquals(listOf(HubRoute(Tab.WORK), TaskDetailRoute("t9")), router.stack(Tab.WORK))
        assertEquals(listOf(HubRoute(Tab.OVERVIEW)), router.stack(Tab.OVERVIEW), "the form is gone")
        assertEquals(TaskDetailRoute("t9"), router.createdWork)
        assertEquals("Started Fix login", router.createdToast)
        router.consumeCreatedToast()
        assertNull(router.createdToast)

        // The form opened on Work, over a detail: Work shows the hub + the new detail only.
        val onWork = AppRouter()
        onWork.select(Tab.WORK)
        onWork.push(AgentDetailRoute("a1"))
        onWork.push(NewWorkRoute(preset = "pr-review"))
        onWork.showCreatedWork(JobRunRoute("j1", "r1"), toast = "Started")
        assertEquals(listOf(HubRoute(Tab.WORK), JobRunRoute("j1", "r1")), onWork.stack(Tab.WORK))

        // The edit form on Library.
        val editing = AppRouter()
        editing.select(Tab.LIBRARY)
        editing.push(RepoDetailRoute("r1"))
        editing.push(EditWorkRoute("w1"))
        editing.showCreatedWork(LocalTerminalRoute("lt1"), toast = "Saved")
        assertEquals(listOf(HubRoute(Tab.LIBRARY), RepoDetailRoute("r1")), editing.stack(Tab.LIBRARY))
        assertEquals(listOf(HubRoute(Tab.WORK), LocalTerminalRoute("lt1")), editing.stack(Tab.WORK))
    }

    @Test
    fun theNavigatorForwardsToTheRouter() {
        val router = AppRouter()
        val external = mutableListOf<String>()
        val navigator = RouterNavigator(router) { external += it }
        navigator.openDeepLink("optio://tasks/t1")
        assertEquals(listOf(HubRoute(Tab.WORK), TaskDetailRoute("t1")), router.stack(Tab.WORK))
        navigator.push(NewWorkRoute())
        navigator.showCreatedWork(TaskDetailRoute("t2"), "Started")
        assertEquals(listOf(HubRoute(Tab.WORK), TaskDetailRoute("t2")), router.stack(Tab.WORK))
        navigator.openExternal("https://github.com/o/r/pull/1")
        assertEquals(listOf("https://github.com/o/r/pull/1"), external)

        val routed = mutableListOf<String>()
        RouterNavigator(router, onOpenDeepLink = { routed += it }, onOpenExternal = {}).openDeepLink("optio://needs-you?server=s")
        assertEquals(listOf("optio://needs-you?server=s"), routed)

        // The no-op navigator accepts everything.
        Navigator.None.openDeepLink("optio://tasks/t1")
        Navigator.None.showCreatedWork(TaskDetailRoute("t"), "x")
    }
}
