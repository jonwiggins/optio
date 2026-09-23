package dev.optio.feature.glance

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import dev.optio.core.data.ServerColor
import dev.optio.core.data.ServerProfile
import dev.optio.core.glance.FcmAvailability
import dev.optio.core.glance.GlanceWatchState
import dev.optio.core.glance.NotificationPermissionState
import dev.optio.core.glance.PushRegistration
import dev.optio.core.glance.PushState
import dev.optio.core.glance.ServerPushState
import dev.optio.core.model.WatchPhase
import dev.optio.core.testing.ScreenSize
import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.captureScreens
import dev.optio.feature.glance.GlanceTestEnv.item
import dev.optio.feature.glance.settings.PromotionState
import dev.optio.feature.glance.settings.WatchSettingsActions
import dev.optio.feature.glance.settings.WatchSettingsContent
import dev.optio.feature.glance.settings.WatchSettingsUiState
import kotlin.test.Test
import kotlin.test.assertEquals

/** `WatchSettingsRoute` with sample data, light and dark (`./gradlew :feature:glance:recordRoborazziDebug`). */
class WatchSettingsScreenshotTest : ScreenshotTest() {
    private val laptop = ServerProfile(id = "srv-1", name = "MacBook Pro", url = "http://laptop.tailnet.ts.net:30400", color = ServerColor.SLATE)
    private val studio = ServerProfile(id = "srv-2", name = "Studio", url = "http://studio.tailnet.ts.net:30400", color = ServerColor.TEAL)

    private val waiting =
        GlanceWatchState(
            phase = WatchPhase.WAITING,
            head = item("t1"),
            others = listOf(item("t2", minutesAgo = 1)),
            needsYouCount = 2,
            runningCount = 3,
            asOf = GlanceTestEnv.now,
        )

    /** The common case today: no Firebase in the build, the background check and keep-watching on. */
    @Test
    fun watchingWithoutFirebase() =
        captureScreens("WatchSettings_watching", size = ScreenSize.TALL) {
            WatchSettingsContent(
                state =
                    WatchSettingsUiState(
                        watch = waiting,
                        watchShowing = true,
                        push =
                            PushState(
                                permission = NotificationPermissionState.GRANTED,
                                fcm = FcmAvailability.NotConfigured,
                                keepWatching = true,
                                keepWatchingActive = true,
                                lastPollAt = GlanceTestEnv.now.minusSeconds(7 * 60),
                                servers = mapOf("srv-1" to ServerPushState("srv-1"), "srv-2" to ServerPushState("srv-2")),
                            ),
                        servers = listOf(laptop, studio),
                        activeServerId = "srv-1",
                        promotion = PromotionState.ALLOWED,
                    ),
                actions = WatchSettingsActions(),
            )
        }

    /** Firebase configured: one server pushes, one has no FCM credentials, one failed; not asked for permission yet. */
    @Test
    fun pushStates() =
        captureScreens("WatchSettings_push", size = ScreenSize.TALL) {
            val push =
                PushState(
                    permission = NotificationPermissionState.NOT_DETERMINED,
                    fcm = FcmAvailability.Available,
                    token = "eXampleFcmToken0123456789abcdefgh:APA91bQwerty",
                    servers =
                        mapOf(
                            "srv-1" to ServerPushState("srv-1", PushRegistration.REGISTERED, serverCanPush = true, deviceId = "d1"),
                            "srv-2" to ServerPushState("srv-2", PushRegistration.FAILED, error = "Could not connect to the server."),
                        ),
                    lastPollError = "Could not connect to the server.",
                    lastPollAt = GlanceTestEnv.now.minusSeconds(3600),
                )
            WatchSettingsContent(
                state = WatchSettingsUiState(watch = null, push = push, servers = listOf(laptop, studio), activeServerId = "srv-1", promotion = PromotionState.OFF),
                actions = WatchSettingsActions(),
            )
        }

    @Test
    fun controlsCallTheirActions() {
        var keep: Boolean? = null
        var checked = 0
        var asked = 0
        captureScreens("WatchSettings_quiet", modes = listOf(dev.optio.core.testing.ThemeMode.LIGHT), interact = {
            onNodeWithTag("keep-watching-switch").performClick()
            onNodeWithTag("check-now").performClick()
            onNodeWithTag("enable-notifications").assertIsDisplayed().performClick()
        }) {
            WatchSettingsContent(
                state =
                    WatchSettingsUiState(
                        watch = GlanceWatchState(WatchPhase.DONE, summary = "Sessions ended. 2 answered, 1 PR merged.", asOf = GlanceTestEnv.now),
                        push = PushState(permission = NotificationPermissionState.NOT_DETERMINED, fcm = FcmAvailability.NotConfigured),
                        servers = listOf(laptop),
                        activeServerId = "srv-1",
                    ),
                actions = WatchSettingsActions(setKeepWatching = { keep = it }, checkNow = { checked++ }, requestPermission = { asked++ }),
            )
        }
        assertEquals(true, keep)
        assertEquals(1, checked)
        assertEquals(1, asked)
    }
}
