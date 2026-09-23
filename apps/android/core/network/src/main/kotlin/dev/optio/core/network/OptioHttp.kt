package dev.optio.core.network

import java.util.concurrent.TimeUnit
import okhttp3.Dispatcher
import okhttp3.OkHttpClient

/**
 * The process-wide OkHttp clients. Every [ApiClient] (the session's, the per-server clients from
 * `SessionStore.client(serverId)`, sign-in probes) shares [client], so they share one connection
 * pool and dispatcher.
 */
object OptioHttp {
    /** iOS `URLRequest.timeoutInterval = 30`: connect, read and write each time out after 30 s. */
    const val TIMEOUT_SECONDS: Long = 30

    /** Interval of WebSocket pings; a socket whose pong does not arrive in time is failed and reconnected. */
    const val PING_INTERVAL_SECONDS: Long = 20

    /** REST client: 30 s timeouts, and room for the Work feed's parallel fetches to one host. */
    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .readTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .writeTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .dispatcher(
                Dispatcher().apply {
                    maxRequests = 64
                    maxRequestsPerHost = 16
                },
            ).build()
    }

    /** WebSocket client derived from [client]: no read timeout (sockets idle for long), pings instead. */
    val webSocketClient: OkHttpClient by lazy { webSocketClient(client) }

    /** A WebSocket variant of [base] that shares its connection pool and dispatcher. */
    fun webSocketClient(base: OkHttpClient): OkHttpClient =
        base.newBuilder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(PING_INTERVAL_SECONDS, TimeUnit.SECONDS)
            .build()
}
