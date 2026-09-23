package dev.optio.app

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * `optio://` links on their way to the router (iOS `NotificationHandler.deliver/stash/flush` +
 * `MainTabView.handle`).
 *
 * - [deliver] (intents, the dev `OPTIO_DEV_OPEN_URL`, `Navigator.openDeepLink`) parks a link in
 *   [pending] until a signed-in shell takes it: a link that arrives while the session is
 *   restoring or signed out is routed once the shell is on screen.
 * - A link for another paired server (`?server=<id>`) is [stash]ed while the shell switches
 *   servers; the rebuilt shell calls [flushStash] and routes it on the right server.
 */
class DeepLinkInbox {
    private val _pending = MutableStateFlow<String?>(null)

    /** The newest link no shell has taken yet. */
    val pending: StateFlow<String?> = _pending.asStateFlow()

    @Volatile
    private var stashed: String? = null

    /** Queues [url] for the signed-in shell. */
    fun deliver(url: String) {
        _pending.value = url
    }

    /** Claims [url] if it is still pending (one shell routes each link once). */
    fun take(url: String): Boolean = _pending.compareAndSet(url, null)

    /** Holds [url] for the shell a server switch is about to build. */
    fun stash(url: String) {
        stashed = url
    }

    /** Re-queues the stashed link (the rebuilt shell calls this when it starts). */
    fun flushStash() {
        val url = stashed ?: return
        stashed = null
        _pending.value = url
    }
}
