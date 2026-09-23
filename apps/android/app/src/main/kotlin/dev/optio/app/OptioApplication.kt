package dev.optio.app

import android.app.Application
import android.content.Context
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.preferencesDataStoreFile
import dev.optio.core.data.DevServers
import dev.optio.core.data.KeystoreTokenCipher
import dev.optio.core.data.LocalNetworkAccess
import dev.optio.core.data.ServerRegistry
import dev.optio.core.data.SessionStore
import dev.optio.core.data.TokenStore
import dev.optio.core.ui.theme.AppearanceStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

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
 * Compose through [LocalAppGraph]. No DI framework (PLAN §3). Widgets, tiles, workers and
 * notification receivers run in the same process and reach the same [session] through
 * `context.appGraph`.
 */
class AppGraph(val application: Application) {
    /** Outlives every screen: session work, deferred deep links, background timers. */
    val appScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Paired servers (DataStore) and their tokens (Keystore-encrypted DataStore). */
    val serverRegistry: ServerRegistry by lazy { registry(application) }

    /**
     * The live session: active server, current user, the one `ApiClient` + `EventHub`. A server
     * on the local network without Android 17's local network permission counts as unreachable at
     * once (`LocalNetworkAccess.isBlocked`).
     */
    val session: SessionStore by lazy {
        SessionStore(
            registry = serverRegistry,
            scope = appScope,
            reachable = { server -> !LocalNetworkAccess.isBlocked(application, server.url) },
        )
    }

    /** `optio://` links waiting for the signed-in shell (and for a server switch to finish). */
    val deepLinks = DeepLinkInbox()

    /** System / light / dark (Settings changes it; read before the first frame). */
    val appearanceStore: AppearanceStore = AppearanceStore.create(application)

    private val _toasts = MutableSharedFlow<String>(replay = 1, extraBufferCapacity = 4, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** Confirmations raised outside Compose; the root shows them with the app's toaster. */
    val toasts: SharedFlow<String> = _toasts.asSharedFlow()

    /** Shows [message] as a success toast once the app is on screen. */
    fun toast(message: String) {
        _toasts.tryEmit(message)
    }

    /** The local network permission prompt was shown in this process (ask at most once). */
    @Volatile
    var askedForLocalNetwork = false

    private val startLock = Mutex()
    private var restored = false

    /**
     * Restores the session once per process (iOS `OptioApp.task { await session.restore() }`). In
     * debug builds, launch extras that pair servers ([DevServers]) replace the registry first and
     * restore again, even when the app is already running.
     */
    fun start(devExtras: Map<String, String> = emptyMap()) {
        appScope.launch {
            startLock.withLock {
                val seeded = DevServers.hasServers(devExtras) && session.applyDevServers(devExtras)
                if (seeded || !restored) {
                    restored = true
                    session.restore()
                }
            }
        }
    }

    private companion object {
        // One DataStore per file per process, even if the Application is recreated (Robolectric).
        @Volatile
        private var sharedRegistry: ServerRegistry? = null

        fun registry(context: Context): ServerRegistry =
            sharedRegistry ?: synchronized(this) {
                sharedRegistry ?: ServerRegistry(
                    store = PreferenceDataStoreFactory.create { context.preferencesDataStoreFile("optio_servers") },
                    tokens =
                        TokenStore(
                            store = PreferenceDataStoreFactory.create { context.preferencesDataStoreFile("optio_tokens") },
                            cipher = KeystoreTokenCipher(),
                        ),
                ).also { sharedRegistry = it }
            }
    }
}

/** The process's [AppGraph], from any [Context]. */
val Context.appGraph: AppGraph
    get() = (applicationContext as OptioApplication).graph

/** The [AppGraph] for composables. Provided by [MainActivity]. */
val LocalAppGraph = staticCompositionLocalOf<AppGraph> { error("No AppGraph: MainActivity provides LocalAppGraph") }
