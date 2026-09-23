package dev.optio.core.ui.format

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import java.time.Clock
import java.time.Instant
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.delay

/**
 * The clock every relative time on screen reads ("2 min. ago", "resets in 3h"). The system clock
 * in the app; screenshot tests provide `Clock.fixed(…)` so times render the same on every run
 * (`captureScreens` in `:core:testing` does this by default).
 */
val LocalClock = staticCompositionLocalOf<Clock> { Clock.systemDefaultZone() }

/**
 * "Now" from [LocalClock], re-read every [every] while the caller is on screen, so relative times
 * stay honest ("updated 12s ago" ages, "resets in" counts down).
 */
@Composable
fun rememberNow(every: Duration = 30.seconds): Instant {
    val clock = LocalClock.current
    var now by remember(clock) { mutableStateOf(clock.instant()) }
    LaunchedEffect(clock, every) {
        while (true) {
            delay(every)
            now = clock.instant()
        }
    }
    return now
}
