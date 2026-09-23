package dev.optio.feature.auth

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.ServerColor
import dev.optio.core.data.ServerRegistry
import dev.optio.core.data.SessionStore
import dev.optio.core.ui.theme.OptioTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Screenshots of the sign-in form (first run and Add server), light and dark, idle / error / busy. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class SignInScreenshotTest {
    @get:Rule
    val compose = createComposeRule()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After
    fun tearDown() = scope.cancel()

    private fun show(form: SignInForm) =
        compose.setContent {
            OptioTheme {
                SignInContent(form = form, onSubmit = {}, onBack = {})
            }
        }

    private fun capture(name: String) = compose.onRoot().captureRoboImage("build/outputs/roborazzi/$name.png")

    private fun firstRun() =
        SignInForm(SignInMode.FIRST).apply {
            serverUrl = "http://laptop.tailnet.ts.net:30400"
            token = "optio_pat_4f2c9a1b"
        }

    private fun addServer() =
        SignInForm(SignInMode.ADD, initialColor = ServerColor.BLUE).apply {
            name = "Studio"
            serverUrl = "http://studio.tailnet.ts.net:30400"
            token = "optio_pat_4f2c9a1b"
        }

    @Test
    fun firstRunLight() {
        show(SignInForm(SignInMode.FIRST))
        compose.onNodeWithText("Connect").assertIsDisplayed()
        capture("SignIn_first_empty")
        compose.onNodeWithTag("sign-in-help").performClick()
        compose.onNodeWithText("optio login").assertIsDisplayed()
        capture("SignIn_first_help")
    }

    @Test
    @Config(qualifiers = "+night")
    fun firstRunDark() {
        show(firstRun())
        capture("SignIn_first_filled_dark")
    }

    @Test
    fun firstRunErrorAndBusy() {
        val form = firstRun().apply { error = SignInError.Unreachable("laptop.tailnet.ts.net") }
        show(form)
        compose.onNodeWithTag("sign-in-error").assertIsDisplayed()
        capture("SignIn_first_error")
        form.error = null
        form.busy = true
        compose.onNodeWithText("Connecting to laptop.tailnet.ts.net…").assertIsDisplayed()
        capture("SignIn_first_busy")
    }

    @Test
    fun localNetworkDenied() {
        show(
            SignInForm(SignInMode.FIRST).apply {
                serverUrl = "http://192.168.1.20:30400"
                token = "optio_pat_4f2c9a1b"
                localNetworkDenied()
            },
        )
        compose.onNodeWithTag("open-settings").assertIsDisplayed()
        capture("SignIn_first_localNetworkDenied")
    }

    @Test
    fun addServerLight() {
        show(addServer())
        compose.onNodeWithText("Pair another Optio instance").assertIsDisplayed()
        compose.onNodeWithText("Add server").assertIsDisplayed()
        capture("SignIn_add")
    }

    @Test
    @Config(qualifiers = "+night")
    fun addServerDark() {
        show(addServer().apply { error = SignInError.Rejected })
        capture("SignIn_add_rejected_dark")
    }

    @Test
    fun theScreenReadsTheSession() {
        val session = SessionStore(ServerRegistry.inMemory(), scope)
        compose.setContent {
            CompositionLocalProvider(LocalSessionStore provides session) {
                OptioTheme { SignInScreen(SignInMode.ADD) }
            }
        }
        compose.onNodeWithTag("add-server-screen").assertIsDisplayed()
        compose.onNodeWithTag("server-color-slate").assertIsDisplayed()
    }
}
