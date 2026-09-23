package dev.optio.feature.widgets.tiles

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.TileService
import androidx.datastore.preferences.core.Preferences
import dev.optio.core.data.DeepLink
import dev.optio.feature.widgets.Links
import dev.optio.feature.widgets.OptioWidgets
import dev.optio.feature.widgets.data.WidgetStore
import dev.optio.feature.widgets.run.RunFiring
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Flags the tiles keep in the widgets' store. */
internal object TileFlags {
    const val NEEDS_YOU = "tile.needsYou.added"

    /** The Needs-you tile is in the panel (so event-driven refreshes are worth fetching). */
    fun needsYouAdded(prefs: Preferences): Boolean = WidgetStore.flag(prefs, NEEDS_YOU)
}

/**
 * The shared plumbing of Optio's tiles: a main-thread scope for reading the store while the panel
 * is open, rendering a [TileLook], and opening the app (`startActivityAndCollapse` with a
 * `PendingIntent` from API 34, the deprecated `Intent` overload before).
 */
abstract class OptioTileService : TileService() {
    protected val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun onStartListening() {
        super.onStartListening()
        scope.launch { render(look()) }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    /** What the tile shows now. */
    protected abstract suspend fun look(): TileLook

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

    protected suspend fun signedIn(): Boolean = OptioWidgets.session()?.registry?.configured()?.isNotEmpty() == true

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

    override suspend fun look(): TileLook {
        val servers = OptioWidgets.session()?.registry?.configured().orEmpty()
        val prefs = WidgetStore.get(this).snapshot()
        return TileStates.needsYou(signedIn = servers.isNotEmpty(), TileStates.mergedNeedsYou(servers, prefs, Instant.now()), servers.size > 1)
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
    override suspend fun look(): TileLook {
        val prefs = WidgetStore.get(this).snapshot()
        val target = TileStates.tileTarget(prefs)
        val started = target?.let { WidgetStore.startedAt(prefs, it.id) }
        return TileStates.runTarget(signedIn(), target, RunFiring.tileShowsStarted(started, Instant.now()))
    }

    override fun onClick() {
        super.onClick()
        scope.launch {
            val prefs = WidgetStore.get(this@RunTargetTileService).snapshot()
            val target = TileStates.tileTarget(prefs)
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
