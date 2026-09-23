package dev.optio.feature.widgets.tiles

import android.service.quicksettings.Tile
import dev.optio.core.glance.GlanceItem
import dev.optio.core.glance.RunTarget
import dev.optio.feature.widgets.R

/** How a Quick Settings tile looks: what `TileService.qsTile` is set to. */
data class TileLook(
    val label: String,
    val subtitle: String?,
    /** `Tile.STATE_ACTIVE` / `STATE_INACTIVE`. */
    val state: Int,
    val icon: Int,
    /** The spoken state (API 30+ `stateDescription`), a whole sentence. */
    val description: String,
)

/**
 * The tiles' looks (iOS `NeedsYouControl` / `NewWorkControl` / `RunTargetControl`), pure so they
 * are unit-tested. The Needs-you tile reads the widgets' cached snapshots, never the network, so
 * it can say "Quiet" the moment the panel opens.
 */
object TileStates {
    /**
     * "Needs you": the needs-you count across every paired server and the oldest item's name, active
     * (highlighted) while anything waits on you. [needsYou] is oldest first, snoozed last.
     */
    fun needsYou(
        signedIn: Boolean,
        needsYou: List<GlanceItem>,
        multiServer: Boolean,
    ): TileLook {
        if (!signedIn) return TileLook("Needs you", "Sign in to Optio", Tile.STATE_INACTIVE, R.drawable.widget_ic_moon, "Sign in to Optio")
        val count = needsYou.size
        if (count == 0) return TileLook("Needs you", "Quiet", Tile.STATE_INACTIVE, R.drawable.widget_ic_moon, "Quiet. No session needs you.")
        val head = needsYou.first()
        val path = if (multiServer && head.serverName != null) "${head.mono} · ${head.serverName}" else head.mono
        val sentence = if (count == 1) "1 session needs you" else "$count sessions need you"
        return TileLook(
            label = "Needs you",
            subtitle = if (count == 1) "1 · ${head.rowName}" else "$count · ${head.rowName}",
            state = Tile.STATE_ACTIVE,
            icon = R.drawable.widget_ic_bot,
            description = "$sentence. Oldest: $path.",
        )
    }

    /** "New work": static, never touches the network. */
    fun newWork(signedIn: Boolean): TileLook =
        TileLook(
            label = "New work",
            subtitle = if (signedIn) "When · Where · Who · What" else "Sign in to Optio",
            state = Tile.STATE_INACTIVE,
            icon = R.drawable.widget_ic_new_work,
            description = if (signedIn) "Start work: a PR, a chat on your machine, a schedule, or an agent." else "Sign in to Optio",
        )

    /** "Run ⟨target⟩": a checkmark for a few seconds after firing. */
    fun runTarget(
        signedIn: Boolean,
        target: RunTarget?,
        justStarted: Boolean,
        firing: Boolean = false,
    ): TileLook {
        val label = target?.let { "Run ${it.name}" } ?: "Run"
        return when {
            !signedIn -> TileLook(label, "Sign in to Optio", Tile.STATE_INACTIVE, R.drawable.widget_ic_play, "Sign in to Optio")
            target == null -> TileLook(label, "Choose a blueprint", Tile.STATE_INACTIVE, R.drawable.widget_ic_play, "Choose a blueprint or Job in the tile's settings")
            firing -> TileLook(label, "Starting…", Tile.STATE_ACTIVE, R.drawable.widget_ic_play, "Starting ${target.name}")
            justStarted -> TileLook(label, "Started", Tile.STATE_ACTIVE, R.drawable.widget_ic_check, "Started ${target.name}")
            else -> TileLook(label, target.subtitle, Tile.STATE_INACTIVE, R.drawable.widget_ic_play, "Run ${target.name}, ${target.subtitle}")
        }
    }
}
