package dev.optio.feature.widgets.tiles

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.service.quicksettings.TileService
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.lifecycle.lifecycleScope
import dev.optio.core.data.DeepLink
import dev.optio.core.glance.RunTarget
import dev.optio.feature.widgets.Links
import dev.optio.feature.widgets.config.RunTargetConfig
import dev.optio.feature.widgets.config.setThemedContent
import dev.optio.feature.widgets.data.WidgetStore
import kotlinx.coroutines.launch

/**
 * A tile's settings (`QS_TILE_PREFERENCES`, the long-press on a tile), and where an unconfigured
 * Run tile's tap lands: the Run tile's target (iOS `RunControlConfigurationIntent`). For the
 * Needs-you and New work tiles, which have nothing to set, it opens the app where the tile would.
 */
class TilePreferencesActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val component = tileComponent(intent)
        if (component != null && component.className != RunTargetTileService::class.java.name) {
            val url = if (component.className == NewWorkTileService::class.java.name) DeepLink.NewWork.url else DeepLink.NeedsYou.url
            startActivity(Links.view(this, url))
            finish()
            return
        }
        setThemedContent {
            val saved by produceState<RunTarget?>(null) { value = WidgetStore.get(this@TilePreferencesActivity).tileTarget() }
            RunTargetConfig(
                title = "Run tile",
                initial = saved,
                confirm = null,
                onClose = ::finish,
                onSave = { target, _ ->
                    lifecycleScope.launch {
                        WidgetStore.get(this@TilePreferencesActivity).setTileTarget(target)
                        TileService.requestListeningState(this@TilePreferencesActivity, ComponentName(this@TilePreferencesActivity, RunTargetTileService::class.java))
                        finish()
                    }
                },
                onOpenApp = { startActivity(Links.launch(this@TilePreferencesActivity)) },
            )
        }
    }

    private fun tileComponent(intent: Intent?): ComponentName? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent?.getParcelableExtra(Intent.EXTRA_COMPONENT_NAME, ComponentName::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra(Intent.EXTRA_COMPONENT_NAME)
        }

    companion object {
        /** Opens the Run tile's target picker (from an unconfigured tile's tap). */
        fun intent(context: Context): Intent =
            Intent(context, TilePreferencesActivity::class.java)
                .putExtra(Intent.EXTRA_COMPONENT_NAME, ComponentName(context, RunTargetTileService::class.java))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
