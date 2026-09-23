package dev.optio.feature.widgets.run

import android.content.Context
import android.widget.Toast
import dev.optio.core.network.ApiError
import dev.optio.feature.widgets.OptioWidgets
import dev.optio.feature.widgets.data.WidgetStore
import dev.optio.feature.widgets.model.GlancePolicy
import dev.optio.feature.widgets.refresh.WidgetTicks
import dev.optio.feature.widgets.refresh.WidgetUpdates
import dev.optio.feature.widgets.shortcuts.AppShortcuts
import java.time.Duration
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withContext

/**
 * Fires run targets from the Run widget, the Run tile and run shortcuts, in the background (iOS
 * `RunTargetIntent`, which runs in the widget extension without launching the app). A success
 * records "started" (the widget shows it for a minute, the tile for a few seconds), and the target
 * joins the launcher's recent-target shortcuts.
 */
internal object RunFiring {
    sealed interface Outcome {
        /** The first of two taps (the widget's "Ask before running"): nothing fired yet. */
        data class Armed(val target: RunTarget) : Outcome

        data class Started(
            val target: RunTarget,
            val receipt: FireReceipt,
        ) : Outcome

        data class Failed(
            val target: RunTarget,
            val reason: String?,
        ) : Outcome

        /** No paired server can take it. */
        data object SignedOut : Outcome
    }

    /** How long the Run tile shows "Started" (iOS: the control's checkmark, ~3 s). */
    val tileFlash: Duration = Duration.ofSeconds(3)

    /**
     * The Run widget's tap: with [confirm], the first tap only arms the widget for ten seconds ("Tap
     * again to run"); a tap while armed fires. WidgetKit had no confirmation dialog for widgets, and
     * neither does a home-screen widget, so two taps stay the honest equivalent.
     */
    suspend fun tap(
        context: Context,
        target: RunTarget,
        confirm: Boolean,
    ): Outcome {
        val store = WidgetStore.get(context)
        val now = Instant.now()
        if (confirm && !GlancePolicy.isArmed(WidgetStore.armedAt(store.snapshot(), target.id), now)) {
            store.setArmed(target.id, now)
            WidgetUpdates.updateRun(context)
            WidgetTicks.scheduleRun(context, GlancePolicy.armWindow.plusSeconds(1))
            return Outcome.Armed(target)
        }
        store.setArmed(target.id, null)
        return fire(context, target)
    }

    /** Fires [target] on its server now (tiles and shortcuts: the gesture already was deliberate). */
    suspend fun fire(
        context: Context,
        target: RunTarget,
    ): Outcome {
        val store = WidgetStore.get(context)
        val client = OptioWidgets.session()?.resolveClient(target.serverId)
        if (client == null) {
            WidgetUpdates.updateRun(context)
            return Outcome.SignedOut
        }
        val outcome =
            try {
                Outcome.Started(target, client.api.fire(target))
            } catch (e: TimeoutCancellationException) {
                Outcome.Failed(target, "timed out")
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                Outcome.Failed(target, e.message)
            } catch (e: Exception) {
                Outcome.Failed(target, e.message)
            }
        if (outcome is Outcome.Started) {
            store.setStarted(target.id, Instant.now())
            AppShortcuts.recordFired(context, target)
            WidgetTicks.scheduleRun(context, GlancePolicy.startedFlash.plusSeconds(1))
            WidgetTicks.scheduleTile(context, tileFlash.plusMillis(500))
        }
        WidgetUpdates.updateRun(context)
        WidgetUpdates.requestTiles(context)
        return outcome
    }

    /** The one-sentence result, as the iOS intents word it. */
    fun message(outcome: Outcome): String =
        when (outcome) {
            is Outcome.Armed -> "Tap again to run ${outcome.target.name}."
            is Outcome.Started ->
                when {
                    outcome.receipt.held -> "${outcome.target.name} is ready — start it from Optio."
                    outcome.receipt.waitsForHost -> "${outcome.target.name} starts when its machine is back online."
                    outcome.receipt.dir != null -> "Started ${outcome.target.name} in ${outcome.receipt.dir}."
                    else -> "Started ${outcome.target.name}."
                }
            is Outcome.Failed -> "Couldn't start ${outcome.target.name}."
            Outcome.SignedOut -> "Sign in to Optio first."
        }

    /** Shows [outcome]'s sentence as a toast (nothing for the arming tap: the widget says it). */
    suspend fun toast(
        context: Context,
        outcome: Outcome,
    ) {
        if (outcome is Outcome.Armed) return
        withContext(Dispatchers.Main) { Toast.makeText(context.applicationContext, message(outcome), Toast.LENGTH_SHORT).show() }
    }

    /** Whether [started] is recent enough for the tile's checkmark. */
    fun tileShowsStarted(
        started: Instant?,
        now: Instant,
    ): Boolean {
        started ?: return false
        val age = Duration.between(started, now)
        return !age.isNegative && age < tileFlash.plusMillis(500)
    }
}
