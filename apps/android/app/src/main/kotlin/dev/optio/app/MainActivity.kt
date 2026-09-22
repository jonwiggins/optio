package dev.optio.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider

/**
 * The single activity (`launchMode="singleTop"`): edge-to-edge Compose, and the target of every
 * `optio://` VIEW intent (widgets, notifications, shortcuts), whether it starts the app or arrives
 * while it runs ([onNewIntent]).
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) handleIntent(intent)
        setContent {
            CompositionLocalProvider(LocalAppGraph provides appGraph) {
                OptioApp()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    /**
     * TODO(C): route `optio://` links (`intent.data`), including `?server=<id>`: switch to that
     * server first, stash the link, and route it once the rebuilt shell is on screen (port of iOS
     * `MainTabView.handle` + `NotificationHandler.stash/flush`). In debug builds also apply the
     * `OPTIO_DEV_*` launch extras (`OPTIO_DEV_SERVER_URL[_n]`, `OPTIO_DEV_TOKEN[_n]`,
     * `OPTIO_DEV_SERVER_NAME[_n]`, `OPTIO_DEV_SECTION`, `OPTIO_DEV_OPEN_URL`; PLAN §6).
     */
    @Suppress("UNUSED_PARAMETER")
    private fun handleIntent(intent: Intent?) = Unit
}
