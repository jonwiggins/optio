package dev.optio.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.CompositionLocalProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import dev.optio.core.data.DeepLink
import dev.optio.core.data.DevServers
import dev.optio.core.data.LocalNetworkAccess
import dev.optio.core.data.SessionStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch

/**
 * The single activity (`launchMode="singleTop"`): edge-to-edge Compose, and the target of every
 * `optio://` VIEW intent (widgets, notifications, shortcuts, other apps), whether it starts the
 * app or arrives while it runs ([onNewIntent]). Links go through [AppGraph.deepLinks], which
 * holds them until the signed-in shell can route them (switching servers first for a
 * `?server=<id>` link; iOS `MainTabView.handle` + `NotificationHandler.stash/flush`).
 *
 * Debug builds also read the `OPTIO_DEV_*` launch extras (PLAN §6): servers to pair
 * (`OPTIO_DEV_SERVER_URL[_n]`, `OPTIO_DEV_TOKEN[_n]`, `OPTIO_DEV_SERVER_NAME[_n]`), a section to
 * open (`OPTIO_DEV_SECTION`), a link delivered ~2 s after launch (`OPTIO_DEV_OPEN_URL`) and a
 * toast to show (`OPTIO_DEV_TOAST`, for checking the toast host).
 *
 * On Android 17 it also asks for local network access ([LocalNetworkAccess]) once per process
 * when the active server is on the local network and the permission is missing (sign-in asks
 * before pairing; this covers restores, switches and a revoked permission).
 */
class MainActivity : ComponentActivity() {
    private val localNetworkRequest =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            // The server was unreachable until now: reconnect the event socket and re-read the user.
            if (granted) appGraph.appScope.launch { appGraph.session.reconnect() }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val fresh = savedInstanceState == null
        appGraph.start(devExtras = if (fresh) devExtras(intent) else emptyMap())
        if (fresh) handleIntent(intent)
        askForLocalNetworkWhenNeeded()
        setContent {
            CompositionLocalProvider(LocalAppGraph provides appGraph) {
                OptioApp()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val extras = devExtras(intent)
        if (DevServers.hasServers(extras)) appGraph.start(devExtras = extras)
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        appGraph.session.appForegrounded()
    }

    override fun onStop() {
        super.onStop()
        appGraph.session.appBackgrounded()
    }

    /** Watches the active server while started; asks once per process when it is local and blocked. */
    private fun askForLocalNetworkWhenNeeded() {
        if (!LocalNetworkAccess.applies) return
        val graph = appGraph
        val session = graph.session
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                combine(session.phase, session.activeServer) { phase, server -> server.takeIf { phase == SessionStore.Phase.SIGNED_IN } }
                    .filterNotNull()
                    .distinctUntilChanged()
                    .collect { server ->
                        if (graph.askedForLocalNetwork) return@collect
                        if (LocalNetworkAccess.needsPrompt(this@MainActivity, server.url)) {
                            graph.askedForLocalNetwork = true
                            localNetworkRequest.launch(LocalNetworkAccess.PERMISSION)
                        }
                    }
            }
        }
    }

    private fun handleIntent(intent: Intent?) {
        if (intent == null) return
        // Relaunched from Recents: the original link was already handled.
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        val links = appGraph.deepLinks
        intent.data?.takeIf { DeepLink.SCHEME.equals(it.scheme, ignoreCase = true) }?.let { links.deliver(it.toString()) }

        if (!BuildConfig.DEBUG) return
        val extras = devExtras(intent)
        extras[DevServers.SECTION]?.takeIf { it.isNotBlank() }?.let { links.deliver(DeepLink.Section(it.trim()).url) }
        extras[DevServers.TOAST]?.takeIf { it.isNotBlank() }?.let(appGraph::toast)
        extras[DevServers.OPEN_URL]?.takeIf { it.isNotBlank() }?.let { url ->
            // Like iOS: ~2 s after launch, without a system "Open with" prompt.
            appGraph.appScope.launch {
                delay(DEV_OPEN_URL_DELAY_MS)
                links.deliver(url.trim())
            }
        }
    }

    /** The `OPTIO_DEV_*` string extras of a debug build's launch intent; empty in release builds. */
    private fun devExtras(intent: Intent?): Map<String, String> {
        if (!BuildConfig.DEBUG || intent == null) return emptyMap()
        return DevServers.keys.mapNotNull { key -> intent.getStringExtra(key)?.let { key to it } }.toMap()
    }

    private companion object {
        const val DEV_OPEN_URL_DELAY_MS = 2_000L
    }
}
