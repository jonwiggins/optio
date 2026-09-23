package dev.optio.feature.widgets.tiles

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.TileService
import dev.optio.core.data.DeepLink
import dev.optio.core.glance.RunTarget
import dev.optio.feature.widgets.Host
import dev.optio.feature.widgets.Links
import dev.optio.feature.widgets.OptioWidgets
import dev.optio.feature.widgets.data.WidgetStore
import dev.optio.feature.widgets.run.RunFiring
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch

/** Flags the tiles keep in the widgets' store. */
internal object TileFlags {
    /** The Needs-you tile is in the panel. */
    const val NEEDS_YOU = "tile.needsYou.added"
}

/**
 * The shared plumbing of Optio's tiles: a main-thread scope for reading the store while the panel
 * is open, rendering a [TileLook], and opening the app (`startActivityAndCollapse` with a
 * `PendingIntent` from API 34, the deprecated `Intent` overload before).
 */
abstract class OptioTileService : TileService() {
    protected val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private var listening: Job? = null

    /**
     * Renders now, then again whenever what the tile shows changes while it listens: a refresh
     * landing, a run started elsewhere, a target saved in the tile's settings. The system does not
     * call [onStartListening] again for a tile that is still listening (an unconfigured Run tile's
     * tap opens its settings without stopping), so waiting for the next call would leave it stale.
     */
    override fun onStartListening() {
        super.onStartListening()
        listening?.cancel()
        listening =
            scope.launch {
                changes().collectLatest {
                    render(look())
                    // A look that goes by itself (the Run tile's checkmark) renders again when it does.
                    expiresIn()?.let {
                        delay(it.toMillis())
                        render(look())
                    }
                }
            }
    }

    override fun onStopListening() {
        listening?.cancel()
        listening = null
        super.onStopListening()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    /** What the tile shows now. */
    protected abstract suspend fun look(): TileLook

    /** What re-renders the tile while it listens; its first value renders it at once. */
    protected open fun changes(): Flow<Unit> = flowOf(Unit)

    /** How long what the tile shows now lasts by itself (null: until something changes). */
    protected open suspend fun expiresIn(): Duration? = null

    protected fun render(look: TileLook) {
        val tile = qsTile ?: return
        tile.label = look.label
        tile.subtitle = look.subtitle
        tile.state = look.state
        tile.icon = Icon.createWithResource(this, look.icon)
        tile.contentDescription = listOfNotNull(look.label, look.subtitle).joinToString(", ")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) tile.stateDescription = look.description
        tile.updateTile()
    }

    protected suspend fun signedIn(): Boolean = Host.session()?.registry?.configured()?.isNotEmpty() == true

    /** Opens [intent] and collapses the panel (unlocking first when the device is locked). */
    @SuppressLint("StartActivityAndCollapseDeprecated")
    protected fun open(intent: Intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val pending = PendingIntent.getActivity(this, intent.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            startActivityAndCollapse(pending)
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}

/**
 * "Needs you" (iOS `NeedsYouControl`, "Jump to what needs me"): opens the Work list's Active view,
 * where needs-you rows rank first (`optio://needs-you`). Its subtitle counts what waits on you
 * across every paired server and names the oldest; it reads the cached snapshots, so it never waits
 * on the network.
 */
class NeedsYouTileService : OptioTileService() {
    override fun onTileAdded() {
        super.onTileAdded()
        OptioWidgets.scope.launch { WidgetStore.get(applicationContext).setFlag(TileFlags.NEEDS_YOU, true) }
    }

    override fun onTileRemoved() {
        super.onTileRemoved()
        OptioWidgets.scope.launch { WidgetStore.get(applicationContext).setFlag(TileFlags.NEEDS_YOU, false) }
    }

    override fun changes(): Flow<Unit> = Host.store(this).changes

    override suspend fun look(): TileLook {
        // Every paired server's cached snapshot, merged oldest first with "Later" items last.
        val entry = Host.loader(this).cached()
        return TileStates.needsYou(signedIn = entry.slices.isNotEmpty(), needsYou = entry.needsYou, multiServer = entry.isMulti)
    }

    override fun onClick() {
        super.onClick()
        open(Links.view(this, DeepLink.NeedsYou.url))
    }
}

/** "New work" (iOS `NewWorkControl`): opens the New work form (`optio://work/new`). Static. */
class NewWorkTileService : OptioTileService() {
    override suspend fun look(): TileLook = TileStates.newWork(signedIn())

    override fun onClick() {
        super.onClick()
        open(Links.view(this, DeepLink.NewWork.url))
    }
}

/**
 * "Run ⟨target⟩" (iOS `RunTargetControl`): fires one Local blueprint or Job in the background,
 * without confirmation (opening the panel and tapping is already deliberate), and shows a
 * checkmark for a few seconds. Long-press opens [TilePreferencesActivity] to pick the target; a tap
 * on an unconfigured tile opens it too.
 */
class RunTargetTileService : OptioTileService() {
    override fun changes(): Flow<Unit> = combine(WidgetStore.get(this).data, Host.store(this).changes) { _, _ -> }

    override suspend fun look(): TileLook {
        val target = WidgetStore.get(this).tileTarget()
        return TileStates.runTarget(signedIn(), target, RunFiring.tileShowsStarted(startedAt(target), Instant.now()))
    }

    override suspend fun expiresIn(): Duration? = RunFiring.tileStartedRemaining(startedAt(WidgetStore.get(this).tileTarget()), Instant.now())

    private suspend fun startedAt(target: RunTarget?): Instant? = target?.let { Host.store(this).startedAt(it.id) }

    override fun onClick() {
        super.onClick()
        scope.launch {
            val target = WidgetStore.get(this@RunTargetTileService).tileTarget()
            if (target == null || !signedIn()) {
                open(TilePreferencesActivity.intent(this@RunTargetTileService))
                return@launch
            }
            val fire = {
                render(TileStates.runTarget(signedIn = true, target = target, justStarted = false, firing = true))
                val app = applicationContext
                OptioWidgets.scope.launch {
                    val outcome = RunFiring.fire(app, target)
                    RunFiring.toast(app, outcome)
                }
                Unit
            }
            if (isLocked) unlockAndRun { fire() } else fire()
        }
    }
}
