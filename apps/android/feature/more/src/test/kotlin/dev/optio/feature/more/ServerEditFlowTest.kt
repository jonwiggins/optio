package dev.optio.feature.more

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.navigation3.runtime.NavKey
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.ServerColor
import dev.optio.core.data.ServerProfile
import dev.optio.core.data.ServerRegistry
import dev.optio.core.data.SessionStore
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Navigator
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.WorkView
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.feature.more.servers.ServerEditScreen
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * The server editor over a real [SessionStore] and the fake API: rename, recolour, re-address and
 * pick a workspace override for a second (not active) server; Save stores it, keeps its token and
 * pops, and the active server is untouched.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class ServerEditFlowTest {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val fake = FakeOptioServerRule()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val registry = ServerRegistry.inMemory()
    private val session = SessionStore(registry, scope)

    @After
    fun tearDown() = scope.cancel()

    private var pops = 0
    private val navigator =
        object : Navigator {
            override fun push(route: NavKey) = Unit

            override fun pop() {
                pops++
            }

            override fun open(section: Section, view: WorkView?) = Unit

            override fun openExternal(url: String) = Unit
        }

    @Test
    fun renameRecolourReaddressAndPickAWorkspace() {
        val server = fake.server
        server.fixture("/api/auth/me", "auth-me-admin.json")
        server.fixture("/api/workspaces", "workspaces.json")
        val home = ServerProfile(id = "home", name = "Home", url = server.baseUrl, color = ServerColor.BLUE)
        // Paired to the same fake API, with an override the picker must not send when listing.
        val studio = ServerProfile(id = "studio", name = "Studio", url = server.baseUrl, workspaceId = DEVLAB)
        runBlocking {
            registry.upsert(home)
            registry.setToken("optio_pat_home", home.id)
            registry.upsert(studio)
            registry.setToken("optio_pat_studio", studio.id)
            registry.setActiveId(home.id)
            session.restore()
        }
        compose.setContent {
            OptioTheme(darkTheme = false) {
                CompositionLocalProvider(LocalSessionStore provides session, LocalNavigator provides navigator) {
                    ServerEditScreen(serverId = "studio")
                }
            }
        }
        compose.onNodeWithTag("server-name").performTextClearance()
        compose.onNodeWithTag("server-name").performTextInput("Mac Studio")
        compose.onNodeWithTag("color-rose").performClick()
        compose.onNodeWithTag("server-url").performTextClearance()
        compose.onNodeWithTag("server-save").assertIsNotEnabled() // no address, no Save
        compose.onNodeWithTag("server-url").performTextInput("studio.example.net:8443")

        compose.waitUntil(5_000) { server.count("GET", "/api/workspaces") > 0 }
        val listing = server.lastRequest("GET", "/api/workspaces")!!
        assertEquals("Bearer optio_pat_studio", listing.headers["Authorization"], "listed with the edited server's token")
        assertNull(listing.headers["x-workspace-id"], "the picker lists every workspace, not the override's")
        compose.onNodeWithTag("server-workspace").performClick()
        compose.onNodeWithText("Side project").performClick()

        compose.onNodeWithTag("server-save").performClick()
        // runOnIdle pumps the main looper, where the view model resumes after saving.
        compose.waitUntil(5_000) { compose.runOnIdle { pops == 1 } }

        val saved = runBlocking { registry.profile("studio") }!!
        assertEquals("Mac Studio", saved.name)
        assertEquals(ServerColor.ROSE, saved.color)
        assertEquals("https://studio.example.net:8443", saved.url, "normalised like sign-in")
        assertEquals(SIDE_PROJECT, saved.workspaceId)
        assertEquals("optio_pat_studio", runBlocking { registry.token("studio") }, "the token is kept")
        assertEquals("home", session.activeServer.value?.id, "editing another server doesn't switch to it")
        assertEquals("Mac Studio", session.servers.value.first { it.id == "studio" }.name, "the session sees the edit")
    }

    private companion object {
        const val DEVLAB = "35802f88-a258-4eca-9817-be325718ab9e"
        const val SIDE_PROJECT = "4a94e89e-13c5-44b9-996b-75d08dcb58e0"
    }
}
