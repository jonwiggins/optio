package dev.optio.feature.sessions

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.theme.OptioTheme
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The session shell against the private test API. Its fake container runtime can't run a shell (the
 * terminal socket closes right after the upgrade), so this checks the graceful path: the controller
 * stops retrying and says why instead of reconnecting forever. Skipped unless `OPTIO_TEST_API_URL`.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class SessionTerminalLiveTest {
    @get:Rule
    val compose = createComposeRule()

    private val baseUrl: String? = System.getenv("OPTIO_TEST_API_URL")?.trimEnd('/')

    @Test
    fun aShellTheServerCantStartStopsWithAReason() {
        assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
        val seed = liveSeed(baseUrl!!)
        val api = ApiClient(baseUrl, seed["api"]?.get("token")?.stringValue ?: "dev")
        val id = checkNotNull(seed["sessions"]?.get("active")?.get("id")?.stringValue)
        lateinit var controller: SessionTerminalController
        compose.setContent {
            val scope = rememberCoroutineScope()
            // The app's socket factory: ws-token auth, 3 s reconnects.
            controller = remember { SessionTerminalController(id, api, scope) }
            val connected by controller.connected.collectAsState()
            val error by controller.error.collectAsState()
            val stopped by controller.stopped.collectAsState()
            OptioTheme(darkTheme = false) {
                SessionTerminalView(controller.terminal, SessionTerminalUi(connected, error, stopped), onReconnect = {}, modifier = Modifier.fillMaxSize(), focusOnShow = false)
            }
        }
        compose.waitUntil(5_000) { controller.terminal.naturalGrid != null }
        compose.runOnIdle { controller.start() }
        compose.waitUntil(20_000) { controller.stopped.value }
        assertEquals("The terminal keeps closing. The session's pod may be gone.", controller.error.value)
        assertTrue(controller.terminal.transcriptText().contains("[disconnected]"))
        assertTrue(!controller.connected.value)
    }
}
