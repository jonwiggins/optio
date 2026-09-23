package dev.optio.feature.tasks.common

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.theme.OptioTheme
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.runner.RunWith

/** Detail header layout: facts that wrap whole, and the header that yields to content when short. */
@RunWith(AndroidJUnit4::class)
class HeaderLayoutTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun factsWrapOnlyBetweenParts() {
        val line = metaText("started 12 min. ago", "Sonnet 4.5", "Claude Code", mono("ab12 cd34"), "$0.42")!!
        val kept = line.keepFactsTogether()
        assertEquals("started 12 min. ago · Sonnet 4.5 · Claude Code · ab12 cd34 · \$0.42", kept.text)
        // Same length: the mono span still covers exactly its fact.
        assertEquals(line.spanStyles.map { it.start to it.end }, kept.spanStyles.map { it.start to it.end })
        assertEquals("ab12 cd34", kept.spanStyles.single().let { kept.text.substring(it.start, it.end) })
        assertEquals(AnnotatedString(""), AnnotatedString("").keepFactsTogether())
    }

    private fun show(height: Dp, scrolling: Boolean = true) {
        compose.setContent {
            OptioTheme(darkTheme = false) {
                Box(Modifier.width(400.dp).height(height)) {
                    CollapsingHeader(header = { Text("Header", Modifier.height(120.dp).testTag("header")) }) {
                        if (scrolling) {
                            LazyColumn(Modifier.testTag("list")) {
                                items((1..60).toList()) { Text("Row $it", Modifier.height(40.dp)) }
                            }
                        } else {
                            Text("Waiting for output…", Modifier.testTag("list"))
                        }
                    }
                }
            }
        }
    }

    @Test
    fun theHeaderItselfAndStillContentDragItToo() {
        // In landscape the logs area can be a sliver; the header (and an empty state) must move it.
        show(height = 300.dp, scrolling = false)
        // Start on the header and drag well past it (a swipe inside it only travels its height minus slop).
        compose.onNodeWithTag("header").performTouchInput {
            swipe(start = bottomCenter.copy(y = bottom - 1f), end = topCenter.copy(y = top - 2 * height), durationMillis = 300)
        }
        compose.waitForIdle()
        assertTrue(compose.onNodeWithTag("header").getBoundsInRoot().bottom <= 0.dp, "the header dragged away")
        compose.onNodeWithTag("list").performTouchInput { swipeDown() }
        compose.waitForIdle()
        assertEquals(0.dp, compose.onNodeWithTag("header").getBoundsInRoot().top)
    }

    @Test
    fun aShortWindowScrollsTheHeaderAwayAndBack() {
        // Regression: in phone landscape header + tabs + composer left the logs no height at all.
        show(height = 300.dp)
        assertEquals(0.dp, compose.onNodeWithTag("header").getBoundsInRoot().top)
        compose.onNodeWithTag("list").performTouchInput { swipeUp() }
        compose.waitForIdle()
        assertTrue(compose.onNodeWithTag("header").getBoundsInRoot().bottom <= 0.dp, "the header scrolled away")
        assertEquals(0.dp, compose.onNodeWithTag("list").getBoundsInRoot().top)
        // Any scroll down brings it back first.
        compose.onNodeWithTag("list").performTouchInput { swipeDown() }
        compose.waitForIdle()
        assertEquals(0.dp, compose.onNodeWithTag("header").getBoundsInRoot().top)
    }

    @Test
    fun aTallWindowKeepsTheHeaderPut() {
        show(height = 700.dp)
        compose.onNodeWithTag("list").performTouchInput { swipeUp() }
        compose.waitForIdle()
        assertEquals(0.dp, compose.onNodeWithTag("header").getBoundsInRoot().top)
        assertEquals(120.dp, compose.onNodeWithTag("list").getBoundsInRoot().top)
    }
}
