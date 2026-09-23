package dev.optio.feature.sessions

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.optio.core.ui.format.isoInstant
import dev.optio.core.ui.format.relativeDescription
import java.time.Instant
import kotlin.math.roundToInt
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Keeps a screen's live socket open while the screen is shown (iOS opens it in `.task` and closes
 * it in `.onDisappear`): [connect] when it enters the composition and when the app returns to the
 * foreground, [disconnect] when it leaves, and [grace] after the app went to the background (a
 * quick app switch keeps the stream).
 */
@Composable
internal fun ConnectWhileShown(
    key: Any,
    connect: () -> Unit,
    disconnect: () -> Unit,
    grace: Duration = 60.seconds,
) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val onConnect by rememberUpdatedState(connect)
    val onDisconnect by rememberUpdatedState(disconnect)
    DisposableEffect(key, lifecycle) {
        var pending: Job? = null
        val observer =
            LifecycleEventObserver { _, event ->
                when (event) {
                    Lifecycle.Event.ON_START -> {
                        pending?.cancel()
                        pending = null
                        onConnect()
                    }
                    Lifecycle.Event.ON_STOP -> {
                        pending?.cancel()
                        pending =
                            scope.launch {
                                delay(grace)
                                onDisconnect()
                            }
                    }
                    else -> Unit
                }
            }
        onConnect()
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            pending?.cancel()
            onDisconnect()
        }
    }
}

/**
 * Pads the bottom so the content ends at the top of the soft keyboard, wherever the content sits
 * in the window. `imePadding()` measures from the window's bottom, which over-pads a screen drawn
 * above the shell's bottom navigation bar; this subtracts the distance between the content's own
 * bottom edge and the window's.
 */
@Composable
internal fun Modifier.imePaddingInWindow(): Modifier {
    val density = LocalDensity.current
    val windowHeight = LocalWindowInfo.current.containerSize.height
    val imeBottom = WindowInsets.ime.getBottom(density)
    var gapBelow by remember { mutableIntStateOf(0) }
    val padding = (imeBottom - gapBelow).coerceAtLeast(0)
    return this
        .onGloballyPositioned { coordinates ->
            gapBelow = (windowHeight - coordinates.boundsInWindow().bottom).roundToInt().coerceAtLeast(0)
        }.padding(bottom = with(density) { padding.toDp() })
}

/**
 * An ISO server timestamp in the past, relative to [now] (the raw string when it doesn't parse). A
 * device clock a little behind the server's would otherwise read "in 16 sec.": those read "now".
 */
internal fun String.sinceDescription(now: Instant): String {
    val date = isoInstant() ?: return this
    return (if (date.isAfter(now)) now else date).relativeDescription(now)
}
