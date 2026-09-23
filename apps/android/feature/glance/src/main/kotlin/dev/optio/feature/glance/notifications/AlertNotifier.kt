package dev.optio.feature.glance.notifications

import android.annotation.SuppressLint
import android.app.Notification
import android.content.Context
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import dev.optio.core.glance.NotificationPermission
import dev.optio.core.glance.NotificationSubject
import dev.optio.core.model.AndroidPushAlert
import dev.optio.feature.glance.AppForeground
import dev.optio.feature.glance.R

/**
 * One alert to show: an FCM `alert` message or a needs-you item the phone found itself. Mirrors
 * the push payload (`docs/android-push.md`): the same categories, copy, deep links and keys.
 */
data class AlertSpec(
    val category: NotificationCategory,
    val title: String,
    val subtitle: String? = null,
    val body: String,
    /** Deep link to open on tap. */
    val url: String,
    /** `local` · `host` · `task` · `agent` · `test`. */
    val kind: String,
    /** Subject id: the target of the actions. */
    val id: String,
    /** Group key (APNs `thread-id`). */
    val threadId: String,
    /** False for `sound: none` (post silently). */
    val audible: Boolean = true,
    /** iOS `time-sensitive`. */
    val timeSensitive: Boolean = false,
    /** The PR a `TASK_PR_OPENED` alert opens. */
    val prUrl: String? = null,
    /** Replace key: a newer alert with the same key replaces the older one. */
    val collapseId: String? = null,
    /** The paired server the alert came from, when known. */
    val serverId: String? = null,
) {
    /** The notification tag: [collapseId], else `<kind>-<id>`. */
    val tag: String
        get() = collapseId?.takeIf { it.isNotEmpty() } ?: "$kind-$id"

    companion object {
        /** An FCM alert (`AndroidPushMessage` `type: "alert"`). */
        fun from(alert: AndroidPushAlert): AlertSpec =
            AlertSpec(
                category = NotificationCategory.of(alert.category),
                title = alert.title,
                subtitle = alert.subtitle,
                body = alert.body,
                url = alert.url,
                kind = alert.kind.raw.takeUnless { it == "__unknown__" } ?: "test",
                id = alert.id,
                threadId = alert.threadId,
                audible = alert.sound != AndroidPushAlert.Sound.NONE,
                timeSensitive = alert.timeSensitive == "1",
                prUrl = alert.prUrl,
                collapseId = alert.collapseId,
                serverId = alert.serverId,
            )
    }
}

/**
 * Posts alerts: one channel per category, the category's actions (Reply via RemoteInput, Later,
 * Resume, Retry, Open, Open PR), a tap that opens the deep link through the app's own intent
 * handling, the collapse id as the tag (a newer alert replaces the older one exactly as on iOS)
 * and the thread id as the group. While the app is on screen, categories iOS keeps out of the
 * foreground — and alerts about the object the user is looking at — post silently.
 */
class AlertNotifier(
    private val context: Context,
) {
    /** Posts [spec]; false when notifications are off (nothing shown). */
    @SuppressLint("MissingPermission")
    fun post(spec: AlertSpec): Boolean {
        if (!NotificationPermission.isGranted(context)) return false
        return try {
            NotificationManagerCompat.from(context).notify(spec.tag, ALERT_ID, build(spec))
            true
        } catch (e: SecurityException) {
            Log.w(TAG, "posting ${spec.tag} failed", e)
            false
        }
    }

    /** Removes the alert with [tag]. */
    fun cancel(tag: String) {
        NotificationManagerCompat.from(context).cancel(tag, ALERT_ID)
    }

    /** The notification for [spec] (no side effects). */
    fun build(
        spec: AlertSpec,
        now: Long = System.currentTimeMillis(),
        inForeground: Boolean = AppForeground.isForeground,
    ): Notification {
        val category = spec.category
        val tapUrl = DeepLinkIntents.tapUrl(spec.url, spec.kind, spec.id, spec.serverId)
        val quiet = !spec.audible || (inForeground && (!category.presentsInForeground || NotificationSubject.isViewing(spec.kind, spec.id)))
        val builder =
            NotificationCompat.Builder(context, category.channel.id)
                .setSmallIcon(R.drawable.ic_stat_optio)
                .setColor(OPTIO_PURPLE)
                .setContentTitle(spec.title)
                .setContentText(spec.body)
                .setSubText(spec.subtitle)
                .setWhen(now)
                .setShowWhen(true)
                .setCategory(category.androidCategory)
                .setGroup(spec.threadId)
                .setAutoCancel(true)
                .setPriority(if (spec.timeSensitive) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(publicVersion(spec))
                .setSilent(quiet)
        if (tapUrl != null) builder.setContentIntent(DeepLinkIntents.viewPending(context, tapUrl, "tap|${spec.tag}"))
        if (category == NotificationCategory.AGENT_REPLY) {
            builder.setStyle(messaging(spec, now))
        } else {
            builder.setStyle(NotificationCompat.BigTextStyle().bigText(spec.body))
        }
        val target =
            ActionTarget(
                source = ActionTarget.Source.ALERT,
                kind = spec.kind,
                id = spec.id,
                serverId = spec.serverId,
                url = tapUrl,
                prUrl = spec.prUrl,
                tag = spec.tag,
                category = category.raw,
                title = spec.title,
            )
        for (action in category.actions) {
            NotificationActions.build(context, action, target)?.let(builder::addAction)
        }
        return builder.build()
    }

    /** Re-posts [spec] after a reply was sent from the notification, showing the reply (the spinner stops). */
    @SuppressLint("MissingPermission")
    fun showReplied(
        spec: AlertSpec,
        reply: String,
    ) {
        if (!NotificationPermission.isGranted(context)) return
        val now = System.currentTimeMillis()
        val notification =
            NotificationCompat.Builder(context, spec.category.channel.id)
                .setSmallIcon(R.drawable.ic_stat_optio)
                .setColor(OPTIO_PURPLE)
                .setContentTitle(spec.title)
                .setContentText("You: $reply")
                .setStyle(messaging(spec, now - 1).addMessage(reply, now, null as Person?))
                .setGroup(spec.threadId)
                .setAutoCancel(true)
                .setSilent(true)
                .setOnlyAlertOnce(true)
                .apply {
                    DeepLinkIntents.tapUrl(spec.url, spec.kind, spec.id, spec.serverId)?.let {
                        setContentIntent(DeepLinkIntents.viewPending(context, it, "tap|${spec.tag}"))
                    }
                }.build()
        try {
            NotificationManagerCompat.from(context).notify(spec.tag, ALERT_ID, notification)
        } catch (e: SecurityException) {
            Log.w(TAG, "re-posting ${spec.tag} failed", e)
        }
    }

    private fun messaging(
        spec: AlertSpec,
        now: Long,
    ): NotificationCompat.MessagingStyle {
        val me = Person.Builder().setName("You").build()
        val agent = Person.Builder().setName(spec.title).setKey("${spec.kind}-${spec.id}").setBot(true).build()
        return NotificationCompat.MessagingStyle(me).addMessage(spec.body, now, agent)
    }

    private fun publicVersion(spec: AlertSpec): Notification =
        NotificationCompat.Builder(context, spec.category.channel.id)
            .setSmallIcon(R.drawable.ic_stat_optio)
            .setColor(OPTIO_PURPLE)
            .setContentTitle(spec.category.channel.title)
            .setContentText("Unlock to see the details")
            .build()

    companion object {
        /** Alerts are keyed by tag (the collapse id) under this one id. */
        const val ALERT_ID = 2

        /** #6d28d9. */
        const val OPTIO_PURPLE = 0xFF6D28D9.toInt()

        private const val TAG = "OptioAlerts"

        /** A `RemoteInput` result key. */
        const val REPLY_KEY = "optio.reply"

        internal fun replyInput(label: String): RemoteInput = RemoteInput.Builder(REPLY_KEY).setLabel(label).build()
    }
}
