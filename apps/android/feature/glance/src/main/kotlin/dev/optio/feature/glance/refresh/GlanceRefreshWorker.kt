package dev.optio.feature.glance.refresh

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.optio.core.glance.GlanceHost
import dev.optio.core.glance.GlanceRefresh
import dev.optio.feature.glance.GlanceRuntime
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * The background check (iOS `AppRefresh`, a `BGAppRefreshTask`): every 15 minutes, with a network,
 * it checks every paired server through the Watch — which caches each server's snapshot for the
 * widgets, posts needs-you alerts for items not seen before, updates or ends the Watch — and then
 * runs the [GlanceRefresh] hooks (widgets, tiles).
 */
class GlanceRefreshWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        if (GlanceHost.clients().isEmpty()) return Result.success()
        val runtime = GlanceRuntime.get(applicationContext)
        return try {
            runtime.watch.reconcile(GlanceRefresh.Reason.POLL)
            runtime.status.update { it.copy(lastPollAt = Instant.now(), lastPollError = runtime.watch.lastError) }
            Result.success()
        } catch (e: Exception) {
            Log.w(TAG, "background check failed", e)
            runtime.status.update { it.copy(lastPollAt = Instant.now(), lastPollError = e.message) }
            Result.success()
        }
    }

    companion object {
        private const val TAG = "OptioRefresh"
    }
}

/** Scheduling for [GlanceRefreshWorker]. */
object GlanceWork {
    /** The periodic check's unique name. */
    const val PERIODIC = "optio.glance.refresh"

    /** A one-off "check now". */
    const val NOW = "optio.glance.refresh.now"

    private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /** Keeps the 15-minute check scheduled (idempotent: an existing schedule is kept). */
    fun schedule(context: Context) {
        runCatching {
            val request =
                PeriodicWorkRequestBuilder<GlanceRefreshWorker>(15, TimeUnit.MINUTES)
                    .setConstraints(network)
                    .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
        }.onFailure { Log.w("OptioRefresh", "scheduling the background check failed", it) }
    }

    /** Runs one check as soon as there is a network. */
    fun runNow(context: Context) {
        runCatching {
            val request = OneTimeWorkRequestBuilder<GlanceRefreshWorker>().setConstraints(network).build()
            WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, request)
        }
    }

    /** Stops checking (signed out of every server). */
    fun cancel(context: Context) {
        runCatching { WorkManager.getInstance(context).cancelUniqueWork(PERIODIC) }
    }
}
