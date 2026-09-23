package dev.optio.feature.overview

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.CreationExtras
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.navigation3.runtime.NavKey
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.ServerRegistry
import dev.optio.core.data.SessionStore
import dev.optio.core.navigation.Navigator
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.WorkView
import dev.optio.core.navigation.routes.NewWorkRoute
import dev.optio.core.navigation.routes.ServersRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.ui.format.LocalClock
import dev.optio.core.ui.theme.OptioTheme
import kotlin.reflect.KClass
import kotlin.test.AfterTest
import kotlin.test.assertEquals
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * The real Overview against two fake servers (the active one serving the seed, another answering
 * its stats): tiles and headers open Work views and sections, the cards push their routes, and a
 * tap on another server switches the session to it.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class OverviewScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val active = FakeOptioServer().start()
    private val other = FakeOptioServer().start()

    @AfterTest
    fun tearDown() {
        scope.cancel()
        active.close()
        other.close()
    }

    private class RecordingNavigator : Navigator {
        val pushed = mutableListOf<NavKey>()
        val opened = mutableListOf<Pair<Section, WorkView?>>()

        override fun push(route: NavKey) {
            pushed += route
        }

        override fun pop() = Unit

        override fun open(section: Section, view: WorkView?) {
            opened += section to view
        }

        override fun openExternal(url: String) = Unit
    }

    private val navigator = RecordingNavigator()

    private fun <T : ViewModel> preloaded(
        type: KClass<T>,
        vm: T,
    ): ViewModelStoreOwner {
        val owner = object : ViewModelStoreOwner {
            override val viewModelStore = ViewModelStore()
        }
        val factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <V : ViewModel> create(modelClass: KClass<V>, extras: CreationExtras): V = vm as V
        }
        ViewModelProvider.create(owner, factory)[type]
        return owner
    }

    private fun show(): SessionStore {
        OverviewSeed.serve(active)
        active.json("/api/auth/me", """{"user":{"id":"u1","email":"dev@localhost","displayName":"Local Dev","workspaceRole":"admin"},"authDisabled":false}""")
        active.webSocket("/ws/events")
        other.fixture("/api/tasks/stats", "overview-tasks-stats.json")
        serveLocalWork(other)
        val registry = ServerRegistry.inMemory()
        runBlocking {
            registry.upsert(OverviewSeed.laptop.copy(url = active.baseUrl))
            registry.setToken("optio_pat_laptop", OverviewSeed.laptop.id)
            registry.upsert(OverviewSeed.studio.copy(url = other.baseUrl))
            registry.setToken("optio_pat_studio", OverviewSeed.studio.id)
            registry.setActiveId(OverviewSeed.laptop.id)
        }
        val session = SessionStore(registry, scope)
        runBlocking { session.restore() }
        val vm = OverviewViewModel(
            api = session.api,
            feedLoad = { OverviewSeed.feedSources },
            otherServers = OtherServersModel { server -> ServerGlances.load(server, session.client(server.id)) },
            clock = OverviewSeed.clock,
        )
        val owner = preloaded(OverviewViewModel::class, vm)
        compose.setContent {
            OptioTheme(darkTheme = false) {
                CompositionLocalProvider(
                    LocalSessionStore provides session,
                    LocalClock provides OverviewSeed.clock,
                    LocalViewModelStoreOwner provides owner,
                ) {
                    OverviewSeed.Hub(navigator) { padding -> OverviewScreen(padding) }
                }
            }
        }
        compose.waitUntilAtLeastOneExists(hasTestTag("overview-subtitle"), 10_000)
        return session
    }

    @Test
    fun tilesAndHeadersOpenWorkViewsAndSections() {
        show()
        compose.onNodeWithTag("stat-recurring").performClick()
        compose.onNodeWithTag("stat-agents").performClick()
        compose.onNodeWithTag("stat-active").performClick()
        compose.onNodeWithTag("stat-waiting").performClick()
        compose.onNodeWithText("Active now").performClick()
        compose.onNodeWithTag("overview-list").performScrollToNode(hasText("Recent"))
        compose.onNodeWithText("Recent").performClick()
        compose.onNodeWithTag("overview-list").performScrollToNode(hasText("Cluster"))
        compose.onNodeWithText("Cluster").performClick()
        assertEquals(
            listOf(
                Section.WORK to WorkView.RECURRING,
                Section.WORK to WorkView.AGENTS,
                Section.WORK to WorkView.ACTIVE,
                Section.WORK to WorkView.ACTIVE,
                Section.WORK to WorkView.ACTIVE,
                Section.WORK to WorkView.HISTORY,
                Section.CLUSTER to null,
            ),
            navigator.opened,
        )
    }

    @Test
    fun cardsPushTheirRoutes() {
        show()
        compose.onNodeWithTag("overview-new-work").performClick()
        compose.onNodeWithTag("board-new-work").performClick()
        compose.onNodeWithTag("active-server").performClick()
        // Only in Recent (cancelled: not on the board).
        compose.onNodeWithTag("overview-list").performScrollToNode(hasText("Refactor analytics events"))
        compose.onNodeWithText("Refactor analytics events").performSemanticsAction(SemanticsActions.OnClick)
        assertEquals(
            listOf(NewWorkRoute(), NewWorkRoute(), ServersRoute, TaskDetailRoute("f1538cdd-438a-480b-a744-f3f79c4a4836")),
            navigator.pushed,
        )
    }

    @Test
    fun anotherServersCountsComeFromItAndATapSwitches() {
        val session = show()
        compose.onNodeWithTag("overview-list").performScrollToNode(hasTestTag("other-server-${OverviewSeed.studio.id}"))
        // Its stats plus its NeedsYouSnapshot (a terminal waiting, one working, the host online).
        compose.waitUntilAtLeastOneExists(hasText("2 need you · 2 running · 1 failed · 1/1 host online"), 10_000)
        assertEquals(1, other.count("GET", "/api/tasks/stats"), "the other server's own stats")
        assertEquals(1, other.count("GET", "/api/local/terminals"))
        compose.onNodeWithTag("other-server-${OverviewSeed.studio.id}").performClick()
        compose.waitUntil(10_000) { session.activeServer.value?.id == OverviewSeed.studio.id }
    }
}
