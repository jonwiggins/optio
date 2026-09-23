package dev.optio.core.terminal

/**
 * Reconnect policy for the Local terminal stream WebSocket (`/ws/local/terminals/:id/stream`). A
 * port of iOS `StreamPolicy.swift` (itself a port of the web's `stream-policy.ts`), pure so it can
 * be unit-tested apart from the emulator and WebSocket plumbing.
 *
 * Close codes the server uses:
 * - 4401: WS authentication failed
 * - 4403: not authorized for this terminal / missing role
 * - 4429: per-IP connection limit
 * - 4503: host (daemon) disconnected; transient, the daemon reconnects
 * - 1000/1005: deliberate close (ours on dispose, or the server's after a fatal error frame like
 *   "Terminal not found")
 */
object StreamPolicy {
    /** What to do when the stream socket closes. */
    sealed interface CloseAction {
        data object Reconnect : CloseAction

        /** Stop for good; [message] is a user-facing line, or null to stop silently. */
        data class Stop(val message: String?) : CloseAction
    }

    /** Close codes that no amount of retrying can fix, with a user-facing line. */
    val permanentCloseMessages: Map<Int, String> =
        mapOf(
            4401 to "Authentication failed — sign in again.",
            4403 to "You don't have permission to view this terminal.",
            4429 to "Too many connections — close other Optio clients.",
        )

    /**
     * Decide what to do when the stream socket closes (the caller already bails before this on
     * dispose).
     *
     * - Permanent rejections (auth/role/limit) stop with a message.
     * - A terminal that has exited/errored stops silently: nothing more will stream, and
     *   reconnecting would only risk wiping the history on screen.
     * - `retryRequested` marks a close we initiated to recover from a retryable error frame (e.g.
     *   "Host is offline"), so its 1000 must still reconnect.
     * - Other normal closes (1000/1005) are deliberate: don't loop on them.
     * - Everything else (4503 host blip, 1001 going away, 1006 abnormal) retries.
     */
    fun closeAction(code: Int, terminalDead: Boolean, retryRequested: Boolean): CloseAction {
        permanentCloseMessages[code]?.let { return CloseAction.Stop(it) }
        if (terminalDead) return CloseAction.Stop(null)
        if (retryRequested) return CloseAction.Reconnect
        if (code == 1000 || code == 1005) return CloseAction.Stop(null)
        return CloseAction.Reconnect
    }

    /**
     * States after which no further bytes will ever stream. Takes the wire value (`LocalTerminalState.raw`
     * in `:core:model`, which this module does not depend on): `"exited"` and `"error"` are dead.
     */
    fun isTerminalStateDead(state: String): Boolean = state == "exited" || state == "error"
}
