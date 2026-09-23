package dev.optio.feature.widgets.run

import android.content.Context
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.testing.unit.hasRunCallbackClickAction
import androidx.glance.appwidget.testing.unit.runGlanceAppWidgetUnitTest
import androidx.glance.testing.unit.assertHasText
import androidx.glance.testing.unit.hasTestTag
import androidx.glance.testing.unit.hasText
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.optio.core.data.ServerColor
import dev.optio.core.glance.RunTarget
import java.time.Instant
import java.util.TimeZone
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** The Run widget's states (iOS `RunFixtures`: idle, armed, started, unconfigured, signed out). */
@RunWith(AndroidJUnit4::class)
class RunWidgetContentTest {
    private val now: Instant = Instant.parse("2026-09-22T16:40:00Z")
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val nightly = RunTarget("srv-laptop|job:nightly", "Nightly release notes", RunTarget.Kind.JOB)
    private val deploy = RunTarget("srv-studio|local:deploy", "Deploy preview", RunTarget.Kind.LOCAL, spawnMode = "auto")

    @Before
    fun utc() {
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    }

    private fun render(
        state: RunWidgetState,
        checks: androidx.glance.appwidget.testing.unit.GlanceAppWidgetUnitTest.() -> Unit,
    ) = runGlanceAppWidgetUnitTest {
        setContext(context)
        setAppWidgetSize(DpSize(170.dp, 170.dp))
        provideComposable { RunWidgetContent(state) }
        checks()
    }

    private fun state(
        target: RunTarget? = nightly,
        confirm: Boolean = true,
        startedAt: Instant? = null,
        armedAt: Instant? = null,
        signedIn: Boolean = true,
    ) = RunWidgetState(signedIn, target, confirm, startedAt, armedAt, now)

    @Test
    fun idleAsksForTwoTaps() =
        render(state()) {
            onNode(hasTestTag("run-name")).assertHasText("Nightly release notes")
            onNode(hasTestTag("run-status")).assertHasText("Tap twice to run")
            onNode(hasText("job")).assertExists()
            onNode(hasRunCallbackClickAction<RunTapAction>()).assertExists()
        }

    @Test
    fun withoutConfirmationOneTapRuns() = render(state(confirm = false)) { onNode(hasTestTag("run-status")).assertHasText("Tap to run") }

    @Test
    fun armedSaysTapAgain() {
        render(state(target = deploy, armedAt = now.minusSeconds(3))) {
            onNode(hasTestTag("run-status")).assertHasText("Tap again to run")
            onNode(hasText("blueprint")).assertExists()
        }
        render(state(target = deploy, armedAt = now.minusSeconds(11))) { onNode(hasTestTag("run-status")).assertHasText("Tap twice to run") }
    }

    @Test
    fun startedShowsWhenForAMinute() {
        render(state(startedAt = now.minusSeconds(2))) { onNode(hasTestTag("run-status")).assertHasText("Started · 4:39 PM") }
        render(state(startedAt = now.minusSeconds(61))) { onNode(hasTestTag("run-status")).assertHasText("Tap twice to run") }
    }

    @Test
    fun namesTheServerWhenSeveralArePaired() =
        render(state(target = deploy).copy(serverName = "Studio", serverColor = ServerColor.TEAL)) {
            onNode(hasText("Studio")).assertExists()
        }

    @Test
    fun unconfiguredAndSignedOut() {
        render(state(target = null)) {
            onNode(hasTestTag("run-name")).assertHasText("Run")
            onNode(hasText("Choose a blueprint or Job to start.")).assertExists()
        }
        render(state(signedIn = false)) { onNode(hasTestTag("signed-out")).assertHasText("Sign in to Optio") }
    }
}
