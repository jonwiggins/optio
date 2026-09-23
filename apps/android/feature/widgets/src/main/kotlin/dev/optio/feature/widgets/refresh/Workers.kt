package dev.optio.feature.widgets.refresh

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import dev.optio.feature.widgets.OptioWidgets
import dev.optio.feature.widgets.model.GlancePolicy
import java.time.Duration
import java.util.concurrent.TimeUnit

/**
 * One background refresh of every paired server for the widgets and tiles. Enqueued when a Work
 * widget is placed or the launcher asks for an update (`APPWIDGET_UPDATE`), after a widget is
 * configured, and on the periodic refresh.
 */
class WidgetRefreshWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val session = OptioWidgets.session() ?: return Result.success()
        WidgetRefresher.refresh(applicationContext, session)
        return Result.success()
    }

    companion object {
        private const val NAME = "optio.widgets.refresh"

        /** Refreshes soon; a refresh already queued absorbs this one. */
        fun enqueue(context: Context) {
            WorkManager.getInstance(context).enqueueUniqueWork(NAME, ExistingWorkPolicy.KEEP, OneTimeWorkRequestBuilder<WidgetRefreshWorker>().build())
        }
    }
}

/**
 * Re-renders without the network when the clock moves a surface on: the Run widget's "Tap again"
 * and "Started" states expiring, and the Work widget turning "as of HH:mm" at the staleness
 * boundary (iOS appends a second timeline entry for each).
 */
class WidgetTickWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        when (inputData.getString(KIND)) {
            RUN -> {
                WidgetUpdates.updateRun(applicationContext)
                WidgetUpdates.requestTiles(applicationContext)
            }
            TILE -> WidgetUpdates.requestTiles(applicationContext)
            else -> {
                WidgetUpdates.updateWork(applicationContext)
                WidgetUpdates.requestTiles(applicationContext)
            }
        }
        return Result.success()
    }

    internal companion object {
        const val KIND = "kind"
        const val RUN = "run"
        const val TILE = "tile"
        const val WORK = "work"
    }
}

internal object WidgetTicks {
    /** Re-renders the Run widget and tile once [after] has passed. */
    fun scheduleRun(
        context: Context,
        after: Duration,
    ) = schedule(context, WidgetTickWorker.RUN, after)

    /** Re-binds the Run tile once its "Started" checkmark is over. */
    fun scheduleTile(
        context: Context,
        after: Duration,
    ) = schedule(context, WidgetTickWorker.TILE, after)

    /** Re-renders the Work widget when its freshest possible snapshot turns stale. */
    fun scheduleStaleFlip(context: Context) = schedule(context, WidgetTickWorker.WORK, GlancePolicy.staleAfter.plusSeconds(5))

    private fun schedule(
        context: Context,
        kind: String,
        after: Duration,
    ) {
        val request =
            OneTimeWorkRequestBuilder<WidgetTickWorker>()
                .setInitialDelay(after.toMillis(), TimeUnit.MILLISECONDS)
                .setInputData(workDataOf(WidgetTickWorker.KIND to kind))
                .build()
        WorkManager.getInstance(context).enqueueUniqueWork("optio.widgets.tick.$kind", ExistingWorkPolicy.REPLACE, request)
    }
}
