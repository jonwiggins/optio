package dev.optio.feature.agents

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.optio.core.ui.format.relativeDescription
import java.time.Instant
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
 * A server timestamp that is in the past, relative to [now]. A device clock a little behind the
 * server's would otherwise read "in 16 sec." for something that just happened: those read "now".
 */
internal fun Instant.sinceDescription(now: Instant): String = (if (isAfter(now)) now else this).relativeDescription(now)
