package dev.optio.app

import android.app.Application
import android.content.Context
import androidx.compose.runtime.staticCompositionLocalOf

/** Process entry point. Builds the one [AppGraph] (manual DI, PLAN §3). */
class OptioApplication : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
    }
}

/**
 * App-wide singletons, created once per process in [OptioApplication.onCreate] and handed to
 * Compose through [LocalAppGraph]. No DI framework (PLAN §3).
 *
 * Placeholder: Agent C adds `ServerRegistry`, `TokenStore` and `SessionStore` (which owns the one
 * `ApiClient` + `EventHub`); glance surfaces (Agent A9) read the same instances.
 */
class AppGraph(val application: Application)

/** The process's [AppGraph], from any [Context]. */
val Context.appGraph: AppGraph
    get() = (applicationContext as OptioApplication).graph

/** The [AppGraph] for composables. Provided by [MainActivity]. */
val LocalAppGraph = staticCompositionLocalOf<AppGraph> { error("No AppGraph: MainActivity provides LocalAppGraph") }
