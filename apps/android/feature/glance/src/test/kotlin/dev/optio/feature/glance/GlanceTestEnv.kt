package dev.optio.feature.glance

import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import androidx.test.core.app.ApplicationProvider
import dev.optio.core.data.ServerClient
import dev.optio.core.data.ServerProfile
import dev.optio.core.glance.GlanceItem
import dev.optio.core.glance.NotificationPermission
import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchSessionSource
import dev.optio.core.model.WatchThen
import dev.optio.core.model.WatchWhere
import dev.optio.core.model.WatchWhereTarget
import dev.optio.core.testing.FakeOptioServer
import dev.optio.feature.glance.notifications.OptioChannel
import java.time.Instant
import org.robolectric.Shadows.shadowOf

/** Robolectric plumbing shared by the glance tests. */
object GlanceTestEnv {
    val now: Instant = Instant.parse("2026-09-22T16:40:00Z")

    /** The app context with notifications allowed and the channels created. */
    fun context(grant: Boolean = true): Context {
        val app = ApplicationProvider.getApplicationContext<Application>()
        if (grant) shadowOf(app).grantPermissions(NotificationPermission.PERMISSION) else shadowOf(app).denyPermissions(NotificationPermission.PERMISSION)
        OptioChannel.createAll(app)
        return app
    }

    fun manager(context: Context): NotificationManager = context.getSystemService(NotificationManager::class.java)

    /** The notification posted as [tag] / [id], if any. */
    fun notification(
        context: Context,
        tag: String?,
        id: Int,
    ): Notification? = shadowOf(manager(context)).getNotification(tag, id)

    /** Every notification currently posted. */
    fun all(context: Context): List<Notification> = shadowOf(manager(context)).allNotifications

    fun title(n: Notification): String? = n.extras.getCharSequence(NotificationCompat.EXTRA_TITLE)?.toString()

    fun text(n: Notification): String? = n.extras.getCharSequence(NotificationCompat.EXTRA_TEXT)?.toString()

    fun bigText(n: Notification): String? = n.extras.getCharSequence(NotificationCompat.EXTRA_BIG_TEXT)?.toString()

    fun actions(n: Notification): List<String> = n.actions.orEmpty().map { it.title.toString() }

    fun remoteInputs(n: Notification): List<RemoteInput> =
        (0 until NotificationCompat.getActionCount(n)).flatMap { NotificationCompat.getAction(n, it)?.remoteInputs.orEmpty().toList() }

    /** The `optio://` URL a content / action PendingIntent opens (Robolectric keeps the intent). */
    fun url(pending: android.app.PendingIntent?): String? = pending?.let { shadowOf(it).savedIntent.dataString }

    fun item(
        id: String,
        kind: WatchItemKind = WatchItemKind.LOCAL,
        state: String = "needs_you",
        minutesAgo: Long = 4,
        server: String? = "srv-1",
        title: String = "claude-code · web",
        mono: String = "web",
        reason: String? = "Waiting on a permission",
        preview: String? = "Allow Bash(pnpm test)? (y/n)",
        prUrl: String? = null,
        snoozedUntil: Instant? = null,
    ): GlanceItem =
        GlanceItem(
            kind = kind,
            id = id,
            title = title,
            mono = mono,
            reason = reason,
            preview = preview,
            since = now.minusSeconds(minutesAgo * 60),
            state = state,
            link =
                when (kind) {
                    WatchItemKind.TASK -> "optio://tasks/$id"
                    WatchItemKind.AGENT -> "optio://agents/$id?compose=1"
                    else -> "optio://local/$id?compose=1"
                } + (server?.let { (if (kind == WatchItemKind.TASK) "?" else "&") + "server=$it" } ?: ""),
            prUrl = prUrl,
            snoozedUntil = snoozedUntil,
            serverId = server,
            serverName = server?.uppercase(),
            source = if (kind == WatchItemKind.LOCAL) WatchSessionSource.LOCAL_TERMINAL else null,
            `when` = "now",
            where = WatchWhere(WatchWhereTarget.MACHINE, "MacBook Pro · ~/repos/optio/apps/web"),
            who = "claude-code",
            then = if (kind == WatchItemKind.AGENT) WatchThen.WAITS_FOR_MESSAGES else WatchThen.WAITS_FOR_ME,
            statusLabel = null,
        )

    fun client(
        server: FakeOptioServer,
        id: String = "srv-1",
        name: String = "Laptop",
    ): ServerClient = ServerClient(ServerProfile(id = id, name = name, url = server.baseUrl), server.client())
}
