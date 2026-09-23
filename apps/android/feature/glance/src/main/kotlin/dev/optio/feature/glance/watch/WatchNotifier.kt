package dev.optio.feature.glance.watch

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.getSystemService
import dev.optio.core.data.DeepLink
import dev.optio.core.glance.GlanceCopy
import dev.optio.core.glance.GlanceItem
import dev.optio.core.glance.GlanceWatchState
import dev.optio.core.glance.NotificationPermission
import dev.optio.core.glance.WatchCopy
import dev.optio.core.glance.label
import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchPhase
import dev.optio.feature.glance.R
import dev.optio.feature.glance.notifications.ActionTarget
import dev.optio.feature.glance.notifications.DeepLinkIntents
import dev.optio.feature.glance.notifications.NotificationAction
import dev.optio.feature.glance.notifications.NotificationActionReceiver
import dev.optio.feature.glance.notifications.NotificationActions
import dev.optio.feature.glance.notifications.OptioChannel

/**
 * The ongoing "Watch" notification: the Android counterpart of the iOS Live Activity
 * (`OptioWidgets/LiveActivity/WatchLiveActivity.swift`). One per phone, whatever is running:
 * the session waiting on you (or the newest running one) as a session row — name, `status ·
 * reason`, the four chips — the counts, a since-timer, and the head's actions (Reply / Message,
 * Later, Open; Resume / Retry for a task needing attention; Open PR). On Android 16+ it asks to be
 * promoted to a Live Update with a short status-chip text.
 *
 * Colour follows the status palette: yellow while a session needs you, purple while sessions work,
 * grey when offline or ended. The preview line (the terminal's last prompt) is private: it is left
 * out of the lock-screen version.
 */
class WatchNotifier(
    private val context: Context,
) {
    /** Whether the Watch (or the keep-watching notification) is on screen right now. */
    val isShowing: Boolean
        get() =
            runCatching {
                context.getSystemService<NotificationManager>()?.activeNotifications?.any { it.id == WATCH_ID && it.tag == null } == true
            }.getOrDefault(false)

    /** Posts [notification] as the Watch; false when notifications are off. */
    @SuppressLint("MissingPermission")
    fun post(notification: Notification): Boolean {
        if (!NotificationPermission.isGranted(context)) return false
        return try {
            NotificationManagerCompat.from(context).notify(WATCH_ID, notification)
            true
        } catch (e: SecurityException) {
            Log.w(TAG, "posting the Watch failed", e)
            false
        }
    }

    fun cancel() {
        NotificationManagerCompat.from(context).cancel(WATCH_ID)
    }

    /**
     * The Watch for [state]. [multiServer] adds the head's server name ("which laptop is asking",
     * iOS `WatchServerTag`); [keepWatching] marks it as the keep-watching service's notification.
     */
    fun build(
        state: GlanceWatchState,
        multiServer: Boolean,
        keepWatching: Boolean = false,
        /** Android shows it as a Live Update (its template drops inline-reply buttons). */
        promoted: Boolean = canPromote(context),
    ): Notification {
        val head = state.head
        val builder = base(state.phase, keepWatching)
        val headline = WatchCopy.headline(state)
        builder.setContentTitle(headline)
        builder.setContentIntent(DeepLinkIntents.viewPending(context, WatchCopy.url(state), "watch|tap"))
        builder.setDeleteIntent(dismissIntent())

        when (state.phase) {
            WatchPhase.WAITING, WatchPhase.WORKING -> {
                if (head == null) {
                    builder.setContentText("No sessions running")
                } else {
                    builder.setContentText("${head.title} · ${WatchCopy.statusLine(head)}")
                    builder.setWhen(head.since.toEpochMilli()).setShowWhen(true).setUsesChronometer(true)
                    val lines = bodyLines(state, head, multiServer)
                    builder.setStyle(NotificationCompat.BigTextStyle().setBigContentTitle(headline).bigText(lines.joinToString("\n")))
                    builder.setPublicVersion(publicVersion(state, head, multiServer, keepWatching))
                    for (action in actions(state, head, promoted)) builder.addAction(action)
                }
                builder.setOngoing(true)
                builder.setShortCriticalText(chipText(state))
                builder.setRequestPromotedOngoing(true)
            }
            WatchPhase.OFFLINE -> {
                val line = WatchCopy.offlineLine(state)
                builder.setContentText(line).setStyle(NotificationCompat.BigTextStyle().bigText(line))
                builder.setOngoing(true)
                builder.setShortCriticalText("offline")
                builder.setRequestPromotedOngoing(true)
            }
            else -> {
                builder.setContentText(WatchCopy.summaryLine(state))
                builder.setOngoing(keepWatching)
                if (!keepWatching) builder.setAutoCancel(true).setTimeoutAfter(DISMISS_AFTER_MS)
            }
        }
        if (keepWatching) builder.addAction(stopKeepWatchingAction())
        return builder.build()
    }

    /** The final frame: "Sessions ended. 3 answered, 1 PR merged." — dismissible, gone after 15 minutes. */
    fun buildEnded(summary: String): Notification =
        base(WatchPhase.DONE, keepWatching = false)
            .setContentTitle(GlanceCopy.headline(WatchPhase.DONE, 0, 0))
            .setContentText(summary)
            .setContentIntent(DeepLinkIntents.viewPending(context, DeepLink.NeedsYou.url, "watch|tap"))
            .setAutoCancel(true)
            .setOngoing(false)
            .setTimeoutAfter(DISMISS_AFTER_MS)
            .build()

    /**
     * "Keep watching" with nothing to show: the foreground service's notification (it must have
     * one). [line] is the last summary, or how many servers are watched.
     */
    fun buildKeepWatching(line: String): Notification =
        base(WatchPhase.DONE, keepWatching = true)
            .setContentTitle("Keeping watch")
            .setContentText(line)
            .setContentIntent(DeepLinkIntents.viewPending(context, DeepLink.NeedsYou.url, "watch|tap"))
            .setOngoing(true)
            .addAction(stopKeepWatchingAction())
            .build()

    // region Pieces

    private fun base(
        phase: WatchPhase,
        keepWatching: Boolean,
    ): NotificationCompat.Builder =
        NotificationCompat.Builder(context, OptioChannel.WATCH.id)
            .setSmallIcon(R.drawable.ic_stat_optio)
            .setColor(tint(phase))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setLocalOnly(true)
            .apply {
                if (keepWatching) setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            }

    /**
     * Expanded body: `name [server]`, `status · reason`, the preview, the counts, the chips. The
     * counts come before the chips (iOS has them last): the shade shows about five lines of a
     * promoted notification, and "1 more needs you · 2 running" matters more than the head's
     * when · where · who · then, which is the line that wraps.
     */
    internal fun bodyLines(
        state: GlanceWatchState,
        head: GlanceItem,
        multiServer: Boolean,
        includePreview: Boolean = true,
    ): List<String> =
        buildList {
            add(head.title + serverTag(head, multiServer))
            val preview = head.preview?.takeIf { includePreview && state.phase == WatchPhase.WAITING && it.isNotBlank() }
            add(WatchCopy.statusLine(head))
            if (preview != null) add("“$preview”")
            WatchCopy.countsLine(state).takeIf { it.isNotEmpty() }?.let(::add)
            add(chips(head))
        }

    /** "now · MacBook · web · Claude Code · waits for me" (Where trimmed to host · leaf, like the island). */
    internal fun chips(head: GlanceItem): String =
        listOf(
            head.whenLabel,
            GlanceCopy.whereLabel(head.whereValue.detail, head.whereValue.target.raw, short = true),
            GlanceCopy.whoLabel(head.whoValue),
            head.thenValue.label,
        ).joinToString(" · ")

    private fun serverTag(
        head: GlanceItem,
        multiServer: Boolean,
    ): String = if (multiServer && head.serverName != null) "  ·  ${head.serverName}" else ""

    /** The lock-screen version when content is hidden: everything but the preview. */
    private fun publicVersion(
        state: GlanceWatchState,
        head: GlanceItem,
        multiServer: Boolean,
        keepWatching: Boolean,
    ): Notification =
        base(state.phase, keepWatching)
            .setContentTitle(WatchCopy.headline(state))
            .setContentText("${head.title} · ${WatchCopy.statusLine(head)}")
            .setStyle(NotificationCompat.BigTextStyle().bigText(bodyLines(state, head, multiServer, includePreview = false).joinToString("\n")))
            .setWhen(head.since.toEpochMilli())
            .setShowWhen(true)
            .setUsesChronometer(true)
            .build()

    /**
     * The head's buttons (iOS `WatchButtons`), at most three. Waiting: Resume / Retry for a task
     * needing attention, Reply (Message for a persistent agent), Open PR, Later, then Open.
     * Working: Open PR for a task at an open PR, nothing otherwise (no filler).
     *
     * Reply answers inline (RemoteInput) — except on a promoted Watch, whose Live Update template
     * drops inline-reply buttons: there it opens the head's composer (`?compose=1`), which is what
     * the iOS Watch's "Reply…" does, and Open (the same place) is left out.
     */
    internal fun actions(
        state: GlanceWatchState,
        head: GlanceItem,
        promoted: Boolean = false,
    ): List<NotificationCompat.Action> {
        val target = target(head)
        val wanted = mutableListOf<Pair<NotificationAction, String>>()
        if (state.phase == WatchPhase.WAITING) {
            if (WatchCopy.isAttentionTask(head)) wanted += NotificationAction.RESUME to NotificationAction.RESUME.title
            if (WatchCopy.isFailedTask(head)) wanted += NotificationAction.RETRY to NotificationAction.RETRY.title
            if (head.kind != WatchItemKind.UNKNOWN) {
                wanted += NotificationAction.REPLY to WatchCopy.replyTitle(head).removeSuffix("…")
            }
            if (WatchCopy.prUrl(head) != null) wanted += NotificationAction.OPEN_PR to NotificationAction.OPEN_PR.title
            wanted += NotificationAction.LATER to NotificationAction.LATER.title
            if (!promoted) wanted += NotificationAction.OPEN to NotificationAction.OPEN.title
        } else if (state.phase == WatchPhase.WORKING && WatchCopy.prUrl(head) != null) {
            wanted += NotificationAction.OPEN_PR to NotificationAction.OPEN_PR.title
        }
        return wanted.take(MAX_ACTIONS).mapNotNull { (action, title) ->
            val opens = if (action == NotificationAction.REPLY && promoted) NotificationAction.OPEN else action
            NotificationActions.build(context, opens, target, title)
        }
    }

    private fun target(head: GlanceItem): ActionTarget =
        ActionTarget(
            source = ActionTarget.Source.WATCH,
            kind = head.kind.raw,
            id = head.id,
            serverId = head.serverId,
            url = DeepLinkIntents.tapUrl(head.link, head.kind.raw, head.id, head.serverId),
            prUrl = head.prUrl,
            tag = "watch-${head.id}",
            title = head.title,
        )

    private fun dismissIntent(): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            DeepLinkIntents.requestCode("watch|dismissed"),
            Intent(context, NotificationActionReceiver::class.java).setAction(ACTION_DISMISSED),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun stopKeepWatchingAction(): NotificationCompat.Action =
        NotificationCompat.Action.Builder(
            0,
            "Stop watching",
            PendingIntent.getBroadcast(
                context,
                DeepLinkIntents.requestCode("watch|stop"),
                Intent(context, NotificationActionReceiver::class.java).setAction(ACTION_STOP_KEEP_WATCHING),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ),
        ).build()

    // endregion

    companion object {
        /** The Watch's notification id (no tag); the keep-watching service uses the same one. */
        const val WATCH_ID = 1

        /** The final frame stays this long (iOS `dismissalPolicy(.after(15 min))`). */
        const val DISMISS_AFTER_MS = 15 * 60 * 1000L

        const val MAX_ACTIONS = 3

        const val ACTION_DISMISSED = "dev.optio.glance.watch.DISMISSED"
        const val ACTION_STOP_KEEP_WATCHING = "dev.optio.glance.watch.STOP_KEEP_WATCHING"

        private const val TAG = "OptioWatch"

        /**
         * The status chip (Live Update; iOS compact trailing): the head's short name and "+N" while
         * waiting ("web +2"), its name while working, "offline". At most [CHIP_MAX] characters:
         * Android drops longer text and shows only the icon, so a long name is cut ("Sec… +1").
         */
        fun chipText(state: GlanceWatchState): String? {
            if (state.phase == WatchPhase.OFFLINE) return "offline"
            val head = state.head ?: return null
            val more = if (state.phase == WatchPhase.WAITING) GlanceCopy.compactTrailing(state.phase, state.needsYouCount, state.runningCount) else ""
            return when (state.phase) {
                WatchPhase.WAITING, WatchPhase.WORKING -> fitChip(head.rowName, more)
                else -> null
            }
        }

        /** [name] (cut with "…" when needed) and [suffix], within [CHIP_MAX] characters. */
        internal fun fitChip(
            name: String,
            suffix: String,
        ): String {
            val room = CHIP_MAX - if (suffix.isEmpty()) 0 else suffix.length + 1
            val fitted = if (name.length <= room) name else name.take(maxOf(1, room - 1)) + "…"
            return if (suffix.isEmpty()) fitted else "$fitted $suffix"
        }

        /** Longest status-chip text Android shows (its guideline; longer text is dropped). */
        const val CHIP_MAX = 7

        /** Phase → accent: yellow needs you, purple working, grey otherwise (iOS `WatchCopy.tint`). */
        fun tint(phase: WatchPhase): Int =
            when (phase) {
                WatchPhase.WAITING -> 0xFFCC8F00.toInt()
                WatchPhase.WORKING -> 0xFF6D28D9.toInt()
                else -> 0xFF8E8E93.toInt()
            }

        /** True when Android lets this app post Live Updates (API 36+; the user can turn it off). */
        fun canPromote(context: Context): Boolean =
            Build.VERSION.SDK_INT >= 36 && runCatching { NotificationManagerCompat.from(context).canPostPromotedNotifications() }.getOrDefault(false)
    }
}
