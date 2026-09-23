package dev.optio.core.ui.components

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Tone

/**
 * The status capsule for detail headers (iOS `StatusBadge`): the only uppercase text in the app.
 * Underscores become spaces. Rows use [StateDot] instead.
 */
@Composable
fun StatusBadge(
    text: String,
    tone: Tone,
    modifier: Modifier = Modifier,
) {
    val fill = when (tone) {
        Tone.ACCENT, Tone.DANGER, Tone.SUCCESS, Tone.WORKING -> tone.color.copy(alpha = 0.14f)
        Tone.IDLE, Tone.MUTED -> OptioTheme.colors.fillTertiary
    }
    Text(
        text = text.replace('_', ' ').uppercase(),
        style = OptioTheme.type.badge,
        color = tone.textColor,
        maxLines = 1,
        softWrap = false,
        modifier = modifier
            .background(fill, Radius.capsuleShape)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

/** A badge for a raw state string, coloured through [Tone.forState]. */
@Composable
fun StatusBadge(
    state: String,
    modifier: Modifier = Modifier,
) {
    StatusBadge(text = state, tone = Tone.forState(state), modifier = modifier)
}

/**
 * The 7dp state dot (iOS `StateDot`): yellow = needs you (the only element allowed to pulse),
 * purple = working, red = failed. Decorative: hidden from accessibility.
 */
@Composable
fun StateDot(
    tone: Tone,
    modifier: Modifier = Modifier,
    size: Dp = 7.dp,
    pulse: Boolean = tone == Tone.ACCENT,
) {
    Dot(color = tone.color, size = size, pulse = pulse, modifier = modifier)
}

/** A plain filled dot in any colour, optionally pulsing (the building block of [StateDot]). */
@Composable
fun Dot(
    color: Color,
    modifier: Modifier = Modifier,
    size: Dp = 7.dp,
    pulse: Boolean = false,
) {
    val layer = if (pulse) {
        val transition = rememberInfiniteTransition(label = "pulse")
        val alpha by transition.animateFloat(
            initialValue = 1f,
            targetValue = 0.35f,
            animationSpec = infiniteRepeatable(tween(durationMillis = 900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
            label = "pulse-alpha",
        )
        Modifier.graphicsLayer { this.alpha = alpha }
    } else {
        Modifier
    }
    Canvas(modifier.size(size).then(layer).clearAndSetSemantics {}) {
        drawCircle(color)
    }
}
