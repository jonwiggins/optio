package dev.optio.feature.tasks.common

import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

/**
 * A detail's [header] (status header, banners, segment tabs) above its [content].
 *
 * On a short window (a phone in landscape) header, tabs, composer and the navigation bar left the
 * content no height at all. There the header scrolls away while the content scrolls up and comes
 * back on any scroll down (Material's "enter always" app bar), so the content always has room.
 * Dragging the header itself, or content that doesn't scroll (an empty state), moves it too:
 * scrolling children take their drags first and hand them on through nested scrolling. On taller
 * windows it is a plain column.
 */
@Composable
internal fun CollapsingHeader(
    modifier: Modifier = Modifier,
    compactBelow: Dp = COMPACT_DETAIL_HEIGHT,
    header: @Composable () -> Unit,
    content: @Composable () -> Unit,
) {
    BoxWithConstraints(modifier.fillMaxSize()) {
        if (maxHeight >= compactBelow) {
            Column(Modifier.fillMaxSize()) {
                header()
                Box(Modifier.weight(1f).fillMaxWidth()) { content() }
            }
            return@BoxWithConstraints
        }
        var headerHeight by remember { mutableIntStateOf(0) }
        var offset by remember { mutableFloatStateOf(0f) }
        val connection = remember {
            object : NestedScrollConnection {
                // Before the content scrolls: a scroll up first hides the header, a scroll down first shows it.
                override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                    val current = offset.coerceAtLeast(-headerHeight.toFloat())
                    val next = (current + available.y).coerceIn(-headerHeight.toFloat(), 0f)
                    offset = next
                    return Offset(0f, next - current)
                }
            }
        }
        // Drags no scrolling child took (on the header, on an empty state) move the header the same way.
        val drag = rememberDraggableState { delta -> connection.onPreScroll(Offset(0f, delta), NestedScrollSource.UserInput) }
        val shown = offset.coerceAtLeast(-headerHeight.toFloat())
        val visible = with(LocalDensity.current) { (headerHeight + shown).coerceAtLeast(0f).toDp() }
        Box(
            Modifier
                .fillMaxSize()
                .clipToBounds()
                .nestedScroll(connection)
                .draggable(drag, Orientation.Vertical)
                .testTag("collapsing-header"),
        ) {
            Box(Modifier.fillMaxSize().padding(top = visible)) { content() }
            Box(
                Modifier
                    .fillMaxWidth()
                    .onSizeChanged { headerHeight = it.height }
                    .offset { IntOffset(0, shown.roundToInt()) },
            ) {
                Column { header() }
            }
        }
    }
}

/** Below this content height a detail's header collapses on scroll (phones in landscape). */
internal val COMPACT_DETAIL_HEIGHT: Dp = 420.dp
