package dev.optio.feature.widgets

import android.content.Context
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.compose
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.optio.core.data.ServerRegistry
import dev.optio.core.data.SessionStore
import dev.optio.core.glance.GlanceHost
import dev.optio.core.glance.GlanceStore
import dev.optio.core.glance.NeedsYouSnapshot
import dev.optio.core.glance.RunTarget
import dev.optio.feature.widgets.run.RunWidget
import dev.optio.feature.widgets.tiles.TileStates
import dev.optio.feature.widgets.work.WidgetSamples
import dev.optio.feature.widgets.work.WorkWidget
import java.time.Duration
import java.time.Instant
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The widgets end to end on the JVM: the real `provideGlance` of each widget reads the paired
 * servers through `GlanceHost` and the shared `GlanceStore` cache, composes, and inflates to views
 * the way a launcher does; the tiles read the same cache.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w412dp-h915dp-420dpi")
class WidgetPipelineTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val now = Instant.now()

    @Before
    fun pairTwoServersAndCacheTheirSnapshots() =
        runBlocking {
            val registry = ServerRegistry.inMemory()
            for (server in listOf(WidgetSamples.laptop, WidgetSamples.studio)) {
                registry.setToken("optio_pat_test", server.id)
                registry.upsert(server)
            }
            registry.setActiveId(WidgetSamples.laptop.id)
            val session = SessionStore(registry, scope)
            GlanceHost.install({ session })
            val store = GlanceStore.get(context)
            store.setCachedSnapshot(
                NeedsYouSnapshot(needsYou = listOf(WidgetSamples.web(now)), running = listOf(WidgetSamples.cli(now)), counts = WidgetSamples.counts, asOf = now),
                WidgetSamples.laptop.id,
            )
            store.setCachedSnapshot(NeedsYouSnapshot(needsYou = listOf(WidgetSamples.forge(now)), asOf = now), WidgetSamples.studio.id)
            store.setCachedTasks(WidgetSamples.tasks(now), WidgetSamples.laptop.id)
            store.setUnreachableSince(null, WidgetSamples.studio.id)
        }

    @After
    fun tearDown() = scope.cancel()

    private fun texts(
        widget: GlanceAppWidget,
        size: DpSize,
    ): List<String> {
        val views = runBlocking { widget.compose(context, size = size) }
        val root = views.apply(context, FrameLayout(context))
        return buildList {
            fun walk(v: View) {
                if (v is TextView && v.visibility == View.VISIBLE) add(v.text.toString())
                if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
            }
            walk(root)
        }
    }

    @Test
    fun workWidgetRendersEveryServersCache() {
        val texts = texts(WorkWidget(), DpSize(364.dp, 382.dp))
        // Two servers merged: web + Vesper need you; cli and the running task run; the open PR waits.
        assertTrue(" need you" in texts, "header: $texts")
        assertTrue("Vesper" in texts && "web" in texts && "cli" in texts, "rows: $texts")
        assertTrue("fix/login-redirect" in texts && "feat/ios-widgets" in texts, "task rows: $texts")
        assertTrue("Recurring" in texts && "4" in texts, "server tiles: $texts")
    }

    @Test
    fun smallWorkWidgetShowsTheCount() {
        val texts = texts(WorkWidget(), DpSize(170.dp, 170.dp))
        assertTrue("2" in texts && "need you" in texts && "2 servers" in texts, "small: $texts")
    }

    @Test
    fun unconfiguredRunWidgetAsksForATarget() {
        val texts = texts(RunWidget(), DpSize(170.dp, 170.dp))
        assertTrue("Choose a blueprint or Job to start." in texts, "run: $texts")
    }

    @Test
    fun needsYouTileReadsTheSameCache() =
        runBlocking {
            val entry = Host.loader(context).cached()
            val look = TileStates.needsYou(entry.slices.isNotEmpty(), entry.needsYou, entry.isMulti)
            assertTrue(look.subtitle == "2 · Vesper", "oldest first across servers: ${look.subtitle}")
            // Later on the oldest moves it to the back.
            GlanceStore.get(context).snooze("a-vesper", Instant.now().plus(Duration.ofMinutes(15)))
            val later = Host.loader(context).cached()
            assertTrue(TileStates.needsYou(true, later.needsYou, later.isMulti).subtitle == "2 · web")
            // The Run tile's target round-trips through the widgets' store.
            val target = RunTarget(RunTarget.makeId(WidgetSamples.laptop.id, RunTarget.Kind.JOB, "nightly"), "Nightly", RunTarget.Kind.JOB)
            dev.optio.feature.widgets.data.WidgetStore.get(context).setTileTarget(target)
            assertTrue(dev.optio.feature.widgets.data.WidgetStore.get(context).tileTarget() == target)
        }
}
