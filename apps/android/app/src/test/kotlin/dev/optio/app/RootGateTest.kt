package dev.optio.app

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import dev.optio.core.data.ServerRegistry
import dev.optio.core.data.SessionStore
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The root gate (iOS `RootView`) end to end against fake servers: restoring → sign-in → the
 * signed-in shell; the hub's server switcher; a `?server=` deep link that switches first.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class RootGateTest {
    @get:Rule
    val compose = createComposeRule()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val servers = mutableListOf<FakeServer>()
    private val registry = ServerRegistry.inMemory()
    private val session = SessionStore(registry, scope)
    private val deepLinks = DeepLinkInbox()
    private val toasts = MutableSharedFlow<String>(replay = 1)

    @Before
    fun setUp() {
        compose.setContent { OptioApp(session = session, deepLinks = deepLinks, appearanceStore = null, toasts = toasts) }
    }

    @After
    fun tearDown() {
        scope.cancel()
        servers.forEach { it.close() }
    }

    private fun server(email: String = "dev@localhost") = FakeServer(email).also(servers::add)

    private fun waitForTag(
        tag: String,
        timeoutMillis: Long = 10_000,
    ) = compose.waitUntilAtLeastOneExists(hasTestTag(tag), timeoutMillis)

    @Test
    fun restoringShowsProgressThenSignIn() {
        compose.onNodeWithTag("restoring").assertIsDisplayed()
        compose.onNodeWithText("Connecting…").assertIsDisplayed()
        runBlocking { session.restore() }
        waitForTag("sign-in-screen")
        compose.onNodeWithText("Optio").assertIsDisplayed()
        compose.onNodeWithText("Remote control for your agents.").assertIsDisplayed()
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/Root_signIn.png")
    }

    @Test
    fun signInHappyPathLandsOnTheShell() {
        val api = server()
        runBlocking { session.restore() }
        waitForTag("sign-in-screen")
        compose.onNodeWithTag("connect").assertIsNotEnabled()
        compose.onNodeWithTag("server-url").performTextInput(api.url)
        compose.onNodeWithTag("server-token").performTextInput("optio_pat_good")
        compose.onNodeWithTag("connect").assertIsEnabled().performClick()

        waitForTag("hub-overview")
        compose.onNodeWithTag("server-switcher").assertIsDisplayed()
        compose.waitUntil(5_000) { session.user.value?.email == "dev@localhost" }
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/Root_signedIn.png")
    }

    @Test
    fun aRejectedTokenSaysSo() {
        val api = server()
        runBlocking { session.restore() }
        waitForTag("sign-in-screen")
        compose.onNodeWithTag("server-url").performTextInput(api.url)
        compose.onNodeWithTag("server-token").performTextInput("optio_pat_wrong")
        compose.onNodeWithTag("connect").performClick()
        compose.waitUntilAtLeastOneExists(hasText("The server rejected that token", substring = true), 10_000)
        compose.onNodeWithTag("sign-in-screen").assertIsDisplayed()
    }

    @Test
    fun theSwitcherSwitchesServersAndOpensAddServer() {
        val first = server(email = "first@example.com")
        val second = server(email = "second@example.com")
        val a = runBlocking {
            session.restore()
            session.addServer(first.url, "optio_pat_good", name = "Laptop").also {
                session.addServer(second.url, "optio_pat_good", name = "Studio")
            }
        }
        waitForTag("hub-overview")
        compose.onNodeWithText("Studio").assertIsDisplayed()

        compose.onNodeWithTag("server-switcher").performClick()
        compose.onNodeWithText("Connected to").assertIsDisplayed()
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/Root_switcherMenu.png")
        compose.onNodeWithTag("server-${a.id}").performClick()
        compose.waitUntil(10_000) { session.activeServer.value?.id == a.id && session.user.value?.email == "first@example.com" }
        waitForTag("hub-overview")
        compose.waitUntilAtLeastOneExists(hasText("Laptop"), 5_000)

        // Other hubs show the switcher too once two servers are paired.
        compose.onNodeWithTag("tab-work").performClick()
        compose.onNodeWithTag("server-switcher").assertIsDisplayed()

        compose.onNodeWithTag("server-switcher").performClick()
        compose.onNodeWithTag("add-server").performClick()
        waitForTag("add-server-screen")
        compose.onNodeWithText("Pair another Optio instance").assertIsDisplayed()
    }

    @Test
    fun aDeepLinkForAnotherServerSwitchesFirstThenRoutes() {
        val first = server()
        val second = server()
        val a = runBlocking {
            session.restore()
            session.addServer(first.url, "optio_pat_good").also { session.addServer(second.url, "optio_pat_good") }
        }
        waitForTag("hub-overview")
        deepLinks.deliver("optio://tasks/t1?server=${a.id}")
        compose.waitUntil(10_000) { session.activeServer.value?.id == a.id }
        compose.waitUntilAtLeastOneExists(hasText("TaskDetailRoute(id=t1)"), 10_000)
    }

    @Test
    fun appToastsShowOverTheShell() {
        val api = server()
        runBlocking {
            session.restore()
            session.addServer(api.url, "optio_pat_good")
        }
        waitForTag("hub-overview")
        toasts.tryEmit("Started Fix login")
        compose.waitUntilAtLeastOneExists(hasTestTag("toast"), 5_000)
        compose.onNodeWithText("Started Fix login").assertIsDisplayed()
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/Root_toast.png")
    }

    @Test
    fun aLinkThatArrivesBeforeSignInIsRoutedAfterwards() {
        val api = server()
        deepLinks.deliver("optio://section/machines")
        runBlocking {
            session.restore()
            session.addServer(api.url, "optio_pat_good")
        }
        waitForTag("hub-library")
        compose.onNodeWithTag("section-machines").assertIsDisplayed()
    }

    /** One fake Optio server: `/api/auth/me` for `optio_pat_good`, ws-token, `/ws/events`. */
    class FakeServer(
        private val email: String,
    ) : AutoCloseable {
        private val server = MockWebServer()
        val requests = CopyOnWriteArrayList<RecordedRequest>()
        val url: String get() = server.url("/").toString().removeSuffix("/")

        init {
            server.dispatcher =
                object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse {
                        requests += request
                        val token = request.headers["Authorization"]?.removePrefix("Bearer ")
                        return when (request.url.encodedPath) {
                            "/api/auth/me" ->
                                if (token == "optio_pat_good") {
                                    json("""{"user":{"id":"u1","email":"$email","displayName":"Dev","workspaceRole":"member"},"authDisabled":false}""")
                                } else {
                                    json("""{"error":"Invalid or expired session"}""", 401)
                                }
                            "/api/auth/ws-token" -> json("""{"token":"ws"}""")
                            "/ws/events" ->
                                MockResponse.Builder().webSocketUpgrade(
                                    object : WebSocketListener() {
                                        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                                            webSocket.close(1000, null)
                                        }
                                    },
                                ).build()
                            else -> json("""{"error":"Route not found"}""", 404)
                        }
                    }
                }
            server.start()
        }

        override fun close() = server.close()

        private fun json(
            body: String,
            code: Int = 200,
        ) = MockResponse.Builder().code(code).setHeader("Content-Type", "application/json").body(body).build()
    }
}
