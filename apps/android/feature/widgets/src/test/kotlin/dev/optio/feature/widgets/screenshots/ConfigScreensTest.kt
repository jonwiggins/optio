package dev.optio.feature.widgets.screenshots

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithTag
import dev.optio.core.data.ServerColor
import dev.optio.core.data.ServerProfile
import dev.optio.core.glance.RunTarget
import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.captureScreens
import dev.optio.core.ui.state.LoadState
import dev.optio.feature.widgets.config.RunTargetConfigContent
import dev.optio.feature.widgets.config.WorkWidgetConfigContent
import dev.optio.feature.widgets.shortcuts.RunConfirmDialog
import java.io.IOException
import org.junit.Test

/**
 * The widgets' setup screens (iOS: the widget / control configuration sheets) and the run-shortcut
 * confirmation, light and dark. `./gradlew :feature:widgets:recordRoborazziDebug`.
 */
class ConfigScreensTest : ScreenshotTest() {
    private val laptop = ServerProfile(id = "srv-laptop", name = "MacBook Pro", url = "http://laptop.tailnet.ts.net:30400", color = ServerColor.SLATE)
    private val studio = ServerProfile(id = "srv-studio", name = "Studio", url = "http://studio.tailnet.ts.net:30400", color = ServerColor.TEAL)

    private val targets =
        listOf(
            RunTarget("srv-laptop|local:fix", "Fix flaky tests", RunTarget.Kind.LOCAL, spawnMode = "auto", serverName = "MacBook Pro"),
            RunTarget("srv-studio|local:deploy", "Deploy preview", RunTarget.Kind.LOCAL, spawnMode = "hold", serverName = "Studio"),
            RunTarget("srv-laptop|job:nightly", "Nightly release notes", RunTarget.Kind.JOB, serverName = "MacBook Pro"),
            RunTarget("srv-laptop|job:triage", "Triage Sentry alerts", RunTarget.Kind.JOB, serverName = "MacBook Pro"),
        )

    @Test
    fun workWidgetSetup() =
        captureScreens("WorkWidgetConfig", interact = { onNodeWithTag("config-save").assertIsEnabled() }) {
            WorkWidgetConfigContent(servers = listOf(laptop, studio), selection = null, onSelect = {}, onClose = {}, onOpenApp = {}, onSave = {})
        }

    @Test
    fun workWidgetSetupOneServer() =
        captureScreens("WorkWidgetConfig_oneServer", modes = listOf(dev.optio.core.testing.ThemeMode.LIGHT)) {
            WorkWidgetConfigContent(servers = listOf(laptop, studio), selection = "srv-studio", onSelect = {}, onClose = {}, onOpenApp = {}, onSave = {})
        }

    @Test
    fun workWidgetSetupSignedOut() =
        captureScreens("WorkWidgetConfig_signedOut", modes = listOf(dev.optio.core.testing.ThemeMode.LIGHT)) {
            WorkWidgetConfigContent(servers = emptyList(), selection = null, onSelect = {}, onClose = {}, onOpenApp = {}, onSave = {})
        }

    @Test
    fun runWidgetSetup() =
        captureScreens("RunWidgetConfig", interact = { onNodeWithTag("config-pin").assertIsEnabled() }) {
            RunTargetConfigContent(
                title = "Run widget", signedOut = false, targets = LoadState.Loaded(targets), initial = null,
                selectedId = "srv-laptop|job:nightly", onSelect = {}, askFirst = true, onAskFirst = {}, onRetry = {},
                onClose = {}, onSave = { _, _ -> }, onOpenApp = {}, onPin = {},
            )
        }

    @Test
    fun runTileSetupNothingChosen() =
        captureScreens("RunTileConfig", modes = listOf(dev.optio.core.testing.ThemeMode.LIGHT), interact = { onNodeWithTag("config-save").assertIsNotEnabled() }) {
            RunTargetConfigContent(
                title = "Run tile", signedOut = false, targets = LoadState.Loaded(targets), initial = null,
                selectedId = null, onSelect = {}, askFirst = null, onAskFirst = {}, onRetry = {},
                onClose = {}, onSave = { _, _ -> }, onOpenApp = {},
            )
        }

    @Test
    fun runSetupStates() {
        captureScreens("RunWidgetConfig_loading", modes = listOf(dev.optio.core.testing.ThemeMode.LIGHT)) {
            RunTargetConfigContent("Run widget", false, LoadState.Loading(), null, null, {}, true, {}, {}, {}, { _, _ -> }, {})
        }
        captureScreens("RunWidgetConfig_empty", modes = listOf(dev.optio.core.testing.ThemeMode.LIGHT)) {
            RunTargetConfigContent("Run widget", false, LoadState.Loaded(emptyList()), null, null, {}, true, {}, {}, {}, { _, _ -> }, {})
        }
        captureScreens("RunWidgetConfig_error", modes = listOf(dev.optio.core.testing.ThemeMode.LIGHT)) {
            RunTargetConfigContent("Run widget", false, LoadState.Failed(IOException("timeout")), null, null, {}, true, {}, {}, {}, { _, _ -> }, {})
        }
    }

    @Test
    fun runShortcutConfirmation() =
        captureScreens("RunShortcutConfirm", wholeScreen = true) {
            RunConfirmDialog(targets[2], onRun = {}, onDismiss = {})
        }
}
