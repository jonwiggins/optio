package dev.optio.feature.widgets

import android.content.Context
import dev.optio.core.data.ServerClient
import dev.optio.core.data.SessionStore
import dev.optio.core.glance.GlanceHost
import dev.optio.core.glance.GlanceLoader
import dev.optio.core.glance.GlanceStore

/**
 * Where the widgets, tiles and shortcuts reach the app: its one [SessionStore] (paired servers,
 * tokens, a client per server, the event hub), through `:core:glance`'s [GlanceHost], which the
 * app installs from `Application.onCreate`; and the glance cache they render from, shared with the
 * Watch, notifications and the background check.
 */
internal object Host {
    /** The app's session, or null before the app installed it (bare unit tests). */
    fun session(): SessionStore? = GlanceHost.session

    /** Every paired server with a client, active first; empty when signed out. */
    suspend fun clients(): List<ServerClient> = GlanceHost.clients()

    fun store(context: Context): GlanceStore = GlanceStore.get(context)

    /** A loader over the shared cache and the paired servers. */
    fun loader(context: Context): GlanceLoader = GlanceHost.loader(context)
}
