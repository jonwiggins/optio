package dev.optio.core.ui.usage

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.lifecycle.compose.LifecycleResumeEffect
import dev.optio.core.model.LocalHost
import dev.optio.core.network.ApiClient
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.state.ErrorText
import java.time.Duration
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlin.time.toJavaDuration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Where [UsageStore] reads from. [ApiUsageSource] in the app; fakes in tests. */
interface UsageSource {
    /** `GET /api/auth/usage` (`fresh` bypasses the server cache). */
    suspend fun accountUsage(fresh: Boolean): ClaudeUsageData

    /** `GET /api/auth/status`. */
    suspend fun authStatus(): DashAuthStatus

    /** `GET /api/local/hosts`. */
    suspend fun localHosts(): List<LocalHost>
}

/** [UsageSource] over an [ApiClient]. */
class ApiUsageSource(val api: ApiClient) : UsageSource {
    override suspend fun accountUsage(fresh: Boolean): ClaudeUsageData = api.accountUsage(fresh)

    override suspend fun authStatus(): DashAuthStatus = api.dashAuthStatus()

    override suspend fun localHosts(): List<LocalHost> = api.usageLocalHosts()
}

/**
 * The one poller behind every usage surface (iOS `UsageStore`): the Overview's limits panel, the
 * pill on session headers and the breakdown sheet, so the numbers are fetched once and shared
 * (`useAccountUsage` in the web's `usage-chips.tsx`). Holds Claude's live account usage
 * (`/api/auth/usage`) and the paired hosts (for the Codex snapshot each daemon reads off its
 * machine). Refreshes when a viewer appears, every [POLL_INTERVAL] while any view observes it
 * ([observe] / [ObservesUsage]), and when the app returns to the foreground.
 *
 * The app creates one for the whole signed-in shell ([rememberUsageStore]) and provides it through
 * [LocalUsageStore]; [ObservesUsage] binds it to `LocalApiClient`. A different client, or the same
 * client re-pointed at another server or workspace, drops the cached numbers so one server's usage
 * never shows on another.
 *
 * Call it from the main thread (Compose); [scope] runs the shared fetch, [clock] reads the time
 * (tests pass a virtual clock).
 */
@Stable
class UsageStore(
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
    private val clock: () -> Instant = Instant::now,
) {
    /** Claude's account usage; null until the first answer. */
    var usage: ClaudeUsageData? by mutableStateOf(null)
        private set

    /** The paired hosts (their Codex snapshots). */
    var hosts: List<LocalHost> by mutableStateOf(emptyList())
        private set

    /** When the last fetch landed. */
    var lastFetched: Instant? by mutableStateOf(null)
        private set

    /** A manual ("fresh") refresh is in flight. */
    var refreshing: Boolean by mutableStateOf(false)
        private set

    /** When the last manual refresh landed, for "updated just now". */
    var refreshedAt: Instant? by mutableStateOf(null)
        private set

    /** Why the last manual refresh failed, humanised. */
    var refreshError: String? by mutableStateOf(null)
        private set

    /** How many views are observing right now. */
    var viewerCount: Int by mutableIntStateOf(0)
        private set

    private var source: UsageSource? = null
    private var boundKey: Any? = null
    private var generation = 0
    private var inFlight: Deferred<Unit>? = null
    private var lastFreshAt: Instant? = null

    /** Both providers, in panel order (Claude, Codex). */
    val providerLimits: List<ProviderLimits>
        get() = UsageLimits.collectProviderLimits(usage, hosts, clock())

    /** Claude's header buckets (5h · 7d · 7d <Model>); empty hides the pill. */
    val claudeBuckets: List<ProviderLimits.Window>
        get() = usage?.takeIf { it.available }?.let(UsageLimits::claudeBuckets).orEmpty()

    /**
     * Points the store at the active server's client. A different client, or [api] now configured
     * for another server / token / workspace, drops the cache. A store bound to an explicit
     * [UsageSource] (previews, screenshots) keeps that source.
     */
    fun bind(api: ApiClient) {
        if (source != null && source !is ApiUsageSource) return
        bind(ApiUsageSource(api), ServerKey.of(api))
    }

    /** Points the store at [source]; a [key] different from the bound one drops the cache. */
    fun bind(source: UsageSource, key: Any) {
        if (key == boundKey) return
        this.source = source
        boundKey = key
        generation++
        inFlight = null
        usage = null
        hosts = emptyList()
        lastFetched = null
        refreshedAt = null
        refreshError = null
    }

    /** Refetches unless the cache is younger than [STALE_AFTER]. */
    suspend fun refreshIfStale() {
        rebindIfRepointed()
        val last = lastFetched
        if (last != null && Duration.between(last, clock()) < STALE_AFTER.toJavaDuration()) return
        refresh()
    }

    /** One shared fetch: concurrent callers await the same request. */
    suspend fun refresh(fresh: Boolean = false) {
        rebindIfRepointed()
        inFlight?.let { return it.await() }
        val gen = generation
        val job = scope.async { load(fresh, gen) }
        inFlight = job
        job.invokeOnCompletion { if (inFlight === job) inFlight = null }
        job.await()
    }

    /**
     * Re-reads Claude from Anthropic now (bypassing the server cache) and refetches hosts. Paced:
     * returns false without doing anything within [FRESH_MIN_GAP] of the previous one. Holds
     * [refreshing] for at least [MIN_SPINNER] so the tap visibly did something.
     */
    suspend fun refreshFresh(): Boolean {
        val now = clock()
        lastFreshAt?.let { if (Duration.between(it, now) < FRESH_MIN_GAP.toJavaDuration()) return false }
        lastFreshAt = now
        refreshing = true
        refreshError = null
        val started = clock()
        try {
            refresh(fresh = true)
            val elapsed = Duration.between(started, clock()).toMillis().milliseconds
            if (elapsed < MIN_SPINNER) delay(MIN_SPINNER - elapsed)
            if (refreshError == null) refreshedAt = clock()
        } finally {
            refreshing = false
        }
        return true
    }

    /**
     * Holds the poller open while a view is on screen: refreshes on start (unless fresh), then
     * every [POLL_INTERVAL]. Cancelling the caller (the view leaving) releases it.
     */
    suspend fun observe() {
        viewerCount++
        try {
            while (true) {
                refreshIfStale()
                delay(POLL_INTERVAL)
            }
        } finally {
            viewerCount--
        }
    }

    /**
     * Mirrors `refreshUsage` in the web hook: an unavailable-without-error answer (or a failed call)
     * is cross-checked against `/api/auth/status`, so an expired OAuth token surfaces as the token
     * banner. Results from before a server switch are dropped.
     */
    private suspend fun load(fresh: Boolean, gen: Int) {
        val source = source ?: return
        coroutineScope {
            val hostsResult = async { attempt { source.localHosts() } }
            var newUsage: ClaudeUsageData? = null
            var failure: Exception? = null
            try {
                var u = source.accountUsage(fresh)
                if (!u.available && u.error == null && attempt { source.authStatus() }?.subscription?.expired == true) {
                    u = ClaudeUsageData(available = false, error = EXPIRED)
                }
                newUsage = u
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = e
                if (attempt { source.authStatus() }?.subscription?.expired == true) {
                    newUsage = ClaudeUsageData(available = false, error = EXPIRED)
                }
            }
            val newHosts = hostsResult.await()
            if (gen != generation) return@coroutineScope
            newUsage?.let { usage = it }
            if (fresh) refreshError = failure?.let { ErrorText.humanize(it, what = "usage") }
            newHosts?.let { hosts = it }
            lastFetched = clock()
        }
    }

    /** A client re-pointed since [bind] (server switch) counts as a new server. */
    private fun rebindIfRepointed() {
        val bound = source as? ApiUsageSource ?: return
        val key = ServerKey.of(bound.api)
        if (key != boundKey) bind(ApiUsageSource(bound.api), key)
    }

    private suspend fun <T> attempt(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    /** Identifies what an [ApiClient] points at, so a re-pointed client reads as a new server. */
    private data class ServerKey(val client: ApiClient, val baseUrl: String?, val tokenHash: Int?, val workspaceId: String?) {
        companion object {
            fun of(api: ApiClient) = ServerKey(api, api.baseUrl?.toString(), api.token?.hashCode(), api.workspaceId)
        }
    }

    companion object {
        /** How often an observed store refetches. */
        val POLL_INTERVAL = 60.seconds

        /** A viewer appearing within this window reuses the cached numbers. */
        val STALE_AFTER = 30.seconds

        /** Manual refreshes bypass the server cache — and hit Anthropic — so pace them. */
        val FRESH_MIN_GAP = 15.seconds

        /** A manual refresh shows its spinner at least this long. */
        val MIN_SPINNER = 400.milliseconds

        internal const val EXPIRED = "OAuth token has expired"
    }
}

/**
 * The app's [UsageStore], or null (previews, tests, signed-out): every usage surface renders
 * nothing and [ObservesUsage] does nothing without one.
 */
val LocalUsageStore = staticCompositionLocalOf<UsageStore?> { null }

/** One [UsageStore] for the caller's composition (the signed-in root, outside the server-switch key). */
@Composable
fun rememberUsageStore(): UsageStore {
    val scope = rememberCoroutineScope()
    return remember(scope) { UsageStore(scope) }
}

/**
 * Keeps the shared usage store polling while the caller is on screen (iOS `observesUsage()`):
 * binds it to [api] (`LocalApiClient`), refreshes it now unless fresh, every minute after, and
 * whenever the app returns to the foreground. No-op without a [store].
 */
@Composable
fun ObservesUsage(
    store: UsageStore? = LocalUsageStore.current,
    api: ApiClient = LocalApiClient.current,
) {
    if (store == null) return
    LaunchedEffect(store, api) {
        store.bind(api)
        store.observe()
    }
    val scope = rememberCoroutineScope()
    LifecycleResumeEffect(store) {
        scope.launch { store.refreshIfStale() }
        onPauseOrDispose {}
    }
}
