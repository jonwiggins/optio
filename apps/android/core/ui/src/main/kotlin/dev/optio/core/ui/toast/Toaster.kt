package dev.optio.core.ui.toast

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarVisuals
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalAccessibilityManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.state.ErrorText
import dev.optio.core.ui.theme.OptioColors
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Tone
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** One transient confirmation. [id] distinguishes repeats of the same text. */
@Immutable
data class ToastMessage(val text: String, val tone: Tone, val id: Long)

/**
 * The app-wide transient confirmation (iOS `Toast.swift`, sonner-style), shown as a Material
 * snackbar by [ToastHost]. Action results and action failures use it; never an alert for
 * something that already happened. One toast at a time: a new one replaces the one on screen.
 * Success / info toasts stay 2.5 s, danger ones 4 s (longer with accessibility services on); a tap
 * dismisses.
 *
 * Get it with `LocalToaster.current` (the app provides one from [rememberToaster] and places
 * [ToastHost] once). The default outside the app is [Detached], which ignores every call, so
 * previews and tests need no setup; tests that assert toasts provide their own and read [current].
 */
@Stable
class Toaster(private val scope: CoroutineScope?) {
    /** The snackbar state [ToastHost] renders. */
    val hostState = SnackbarHostState()

    /** The toast on screen (or queued to show), for tests and accessibility; null when none. */
    var current: ToastMessage? by mutableStateOf(null)
        private set

    private var job: Job? = null
    private var nextId = 0L

    /** Shows [message]; [tone] picks the icon ([Tone.SUCCESS] ✓, [Tone.DANGER] !) and duration. */
    fun toast(message: String, tone: Tone = Tone.WORKING) {
        val scope = scope ?: return
        val toast = ToastMessage(message, tone, nextId++)
        job?.cancel()
        current = toast
        job = scope.launch {
            try {
                hostState.showSnackbar(ToastVisuals(toast))
            } finally {
                if (current?.id == toast.id) current = null
            }
        }
    }

    /** A success confirmation ("Saved", "Run started"). */
    fun success(message: String) = toast(message, Tone.SUCCESS)

    /** An action failure in plain words. */
    fun error(message: String) = toast(message, Tone.DANGER)

    /** An action failure, humanised with [ErrorText.humanize] (iOS `errorToast`). */
    fun error(error: Throwable, what: String? = null) = toast(ErrorText.humanize(error, what), Tone.DANGER)

    /** Dismisses the toast on screen. */
    fun dismiss() {
        job?.cancel()
        hostState.currentSnackbarData?.dismiss()
        current = null
    }

    companion object {
        /** A toaster with no host: every call is ignored (the [LocalToaster] default). */
        val Detached = Toaster(scope = null)
    }
}

/** Snackbar visuals carrying the toast's tone; [ToastHost] times it, so the duration is indefinite. */
internal class ToastVisuals(val toast: ToastMessage) : SnackbarVisuals {
    override val message: String get() = toast.text
    override val actionLabel: String? get() = null
    override val withDismissAction: Boolean get() = false
    override val duration: SnackbarDuration get() = SnackbarDuration.Indefinite
}

/** The app's [Toaster]; [Toaster.Detached] (ignores calls) unless the app provides one. */
val LocalToaster = staticCompositionLocalOf { Toaster.Detached }

/** A [Toaster] bound to the caller's composition (the app creates one at the root). */
@Composable
fun rememberToaster(): Toaster {
    val scope = rememberCoroutineScope()
    return remember(scope) { Toaster(scope) }
}

/**
 * Renders [toaster]'s toasts. Place it once, above everything, bottom-centred and clear of the
 * navigation bar, e.g. `Box { MainShell(); ToastHost(toaster, Modifier.align(Alignment.BottomCenter)
 * .navigationBarsPadding().padding(bottom = 80.dp)) }`. Haptics: success on show, reject for
 * danger. Test tag: `toast`.
 */
@Composable
fun ToastHost(
    toaster: Toaster,
    modifier: Modifier = Modifier,
) {
    val haptics = LocalHapticFeedback.current
    val accessibility = LocalAccessibilityManager.current
    SnackbarHost(toaster.hostState, modifier) { data ->
        val tone = (data.visuals as? ToastVisuals)?.toast?.tone ?: Tone.WORKING
        LaunchedEffect(data) {
            haptics.performHapticFeedback(if (tone == Tone.DANGER) HapticFeedbackType.Reject else HapticFeedbackType.Confirm)
            val base = if (tone == Tone.DANGER) 4_000L else 2_500L
            val timeout = accessibility?.calculateRecommendedTimeoutMillis(
                base,
                containsIcons = tone == Tone.SUCCESS || tone == Tone.DANGER,
                containsText = true,
                containsControls = false,
            ) ?: base
            delay(timeout)
            data.dismiss()
        }
        // Snackbars sit on the inverse surface, so their icons take the opposite palette.
        val iconColors = if (OptioTheme.colors.isDark) OptioColors.Light else OptioColors.Dark
        Snackbar(
            modifier = Modifier
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .clickable { data.dismiss() }
                .testTag("toast"),
            containerColor = MaterialTheme.colorScheme.inverseSurface,
            contentColor = MaterialTheme.colorScheme.inverseOnSurface,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                when (tone) {
                    Tone.DANGER -> Icon(Icons.Outlined.ErrorOutline, contentDescription = "Error", tint = iconColors.red, modifier = Modifier.size(20.dp))
                    Tone.SUCCESS -> Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = iconColors.green, modifier = Modifier.size(20.dp))
                    else -> Unit
                }
                Text(data.visuals.message, maxLines = 2)
            }
        }
    }
}
