package dev.optio.feature.glance.notifications

import android.util.Log
import dev.optio.core.data.ServerClient
import dev.optio.core.glance.GlanceStore
import dev.optio.core.glance.WatchSources
import dev.optio.feature.glance.controlPersistentAgent
import dev.optio.feature.glance.resumeTask
import dev.optio.feature.glance.retryTask
import dev.optio.feature.glance.sendLocalTerminalInput
import dev.optio.feature.glance.sendPersistentAgentMessage
import dev.optio.feature.glance.sendTaskMessage
import dev.optio.feature.glance.snoozeLocalTerminal
import java.time.Duration
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Runs notification actions against the API (port of iOS `NotificationHandler.didReceive`):
 * Reply (a terminal gets the text + Enter, an agent a message, a task a message), Later (snooze),
 * Resume, Retry. The subject's server comes from the payload (`serverId`, echoed by servers the
 * app registered with); without one and with several servers paired, the servers are probed for
 * the subject (iOS `resolveServer`). Taps and Open / Open PR are activity intents and never come
 * here.
 */
class NotificationHandler(
    /** Every paired server, active first. */
    private val clients: suspend () -> List<ServerClient>,
    /** The client for a server id, falling back to the active server (`SessionStore.resolveClient`). */
    private val resolve: suspend (String?) -> ServerClient?,
    private val store: GlanceStore,
    private val sources: WatchSources,
    private val alerts: AlertNotifier,
    /** After an action changed something: refresh the Watch and the widgets. */
    private val afterAction: suspend (ActionTarget) -> Unit = {},
) {
    /** What happened, for tests and logs. */
    enum class Outcome { DONE, FAILED, NOTHING_TO_DO, NO_SERVER }

    suspend fun perform(
        action: NotificationAction,
        target: ActionTarget,
        reply: String? = null,
    ): Outcome {
        val outcome =
            try {
                when (action) {
                    NotificationAction.REPLY -> reply(target, reply?.trim().orEmpty())
                    NotificationAction.LATER -> later(target)
                    NotificationAction.RESUME -> resume(target)
                    NotificationAction.RETRY -> retry(target)
                    NotificationAction.OPEN, NotificationAction.OPEN_PR -> Outcome.NOTHING_TO_DO
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "${action.raw} on ${target.kind}/${target.id} failed", e)
                Outcome.FAILED
            }
        if (outcome == Outcome.DONE) runCatching { afterAction(target) }
        return outcome
    }

    private suspend fun reply(
        target: ActionTarget,
        text: String,
    ): Outcome {
        if (text.isEmpty()) {
            repostAlert(target)
            return Outcome.NOTHING_TO_DO
        }
        val client = client(target) ?: return failReply(target, Outcome.NO_SERVER)
        val sent =
            runCatching {
                when (target.kind) {
                    // PTYs take a carriage return as Enter (the in-app "Send + Enter").
                    "local" -> client.api.sendLocalTerminalInput(target.id, text + "\r")
                    "agent" -> {
                        client.api.sendPersistentAgentMessage(target.id, text)
                        sources.recordAgentSendNow(target.id)
                    }
                    "task" -> client.api.sendTaskMessage(target.id, text)
                    else -> error("nothing to reply to for ${target.kind}")
                }
            }
        if (sent.isFailure) {
            Log.w(TAG, "reply to ${target.kind}/${target.id} failed", sent.exceptionOrNull())
            return failReply(target, Outcome.FAILED)
        }
        val tag = target.tag
        if (target.source == ActionTarget.Source.ALERT && tag != null) {
            if (target.category == NotificationCategory.AGENT_REPLY.raw) {
                alerts.showReplied(specFor(target), text)
            } else {
                alerts.cancel(tag)
            }
        }
        return Outcome.DONE
    }

    /** "Later": a local snooze (so this phone's surfaces agree at once) plus the server-side one for terminals. */
    private suspend fun later(target: ActionTarget): Outcome {
        val until = Instant.now().plus(Duration.ofMinutes(SNOOZE_MINUTES.toLong()))
        store.snooze(target.id, until)
        if (target.kind == "local") {
            client(target)?.let { c -> runCatching { c.api.snoozeLocalTerminal(target.id, SNOOZE_MINUTES) } }
        }
        target.tag?.takeIf { target.source == ActionTarget.Source.ALERT }?.let(alerts::cancel)
        return Outcome.DONE
    }

    private suspend fun resume(target: ActionTarget): Outcome {
        val client = client(target) ?: return Outcome.NO_SERVER
        when (target.kind) {
            "task" -> client.api.resumeTask(target.id)
            "agent" -> client.api.controlPersistentAgent(target.id, "resume")
            else -> return Outcome.NOTHING_TO_DO
        }
        target.tag?.takeIf { target.source == ActionTarget.Source.ALERT }?.let(alerts::cancel)
        return Outcome.DONE
    }

    private suspend fun retry(target: ActionTarget): Outcome {
        if (target.kind != "task") return Outcome.NOTHING_TO_DO
        val client = client(target) ?: return Outcome.NO_SERVER
        client.api.retryTask(target.id)
        target.tag?.takeIf { target.source == ActionTarget.Source.ALERT }?.let(alerts::cancel)
        return Outcome.DONE
    }

    /** The server that has the subject: the payload's, else the one a probe finds, else the active one. */
    suspend fun client(target: ActionTarget): ServerClient? {
        target.serverId?.let { return resolve(it) }
        val found = resolveServerId(target.kind, target.id)
        return resolve(found)
    }

    /**
     * The paired server that knows [kind] / [id], active first (iOS `resolveServer`). Null with a
     * single server (nothing to disambiguate) or when none answers.
     */
    suspend fun resolveServerId(
        kind: String,
        id: String,
    ): String? {
        val all = clients()
        if (all.size <= 1 || id.isEmpty()) return null
        val path = probePath(kind, id) ?: return null
        for (c in all) {
            val ok = withTimeoutOrNull(PROBE_TIMEOUT) { runCatching { c.api.raw("GET", path) }.isSuccess } ?: false
            if (ok) return c.server.id
        }
        return null
    }

    private fun failReply(
        target: ActionTarget,
        outcome: Outcome,
    ): Outcome {
        // Stop the reply spinner and say so; the tap still opens the subject.
        if (target.source == ActionTarget.Source.ALERT && target.tag != null) {
            alerts.post(specFor(target).copy(body = "Couldn't send your reply — tap to open", audible = false))
        }
        return outcome
    }

    private fun repostAlert(target: ActionTarget) {
        if (target.source == ActionTarget.Source.ALERT && target.tag != null) alerts.post(specFor(target).copy(audible = false))
    }

    /** Enough of the original alert to re-post it (the payload is gone by now). */
    private fun specFor(target: ActionTarget): AlertSpec =
        AlertSpec(
            category = NotificationCategory.of(target.category),
            title = target.title ?: "Optio",
            body = "",
            url = target.url ?: "",
            kind = target.kind,
            id = target.id,
            threadId = target.id,
            collapseId = target.tag,
            serverId = target.serverId,
            prUrl = target.prUrl,
        )

    companion object {
        /** "Later" snoozes for this long (iOS `SnoozeStore.defaultMinutes`). */
        const val SNOOZE_MINUTES = 15

        private val PROBE_TIMEOUT = 6.seconds
        private const val TAG = "OptioNotificationActions"

        /** The route that answers 200 when a server has [kind] / [id]. */
        fun probePath(
            kind: String,
            id: String,
        ): String? =
            when (kind) {
                "local" -> "/api/local/terminals/$id"
                "task" -> "/api/tasks/$id"
                "agent" -> "/api/persistent-agents/$id"
                "host" -> "/api/local/hosts/$id"
                else -> null
            }
    }
}
