package dev.optio.feature.glance.notifications

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.core.net.toUri
import dev.optio.core.data.DeepLink

/**
 * `optio://` links from notifications into the app. A tap is a plain `VIEW` intent for the app's
 * activity, so it goes through the app's existing intent handling (`MainActivity` → the deep-link
 * inbox, which switches to a `?server=` server first) — the Android counterpart of iOS
 * `NotificationHandler.deliver(url:)`.
 */
object DeepLinkIntents {
    /** [url] with `?server=[serverId]` when it is an `optio://` link without one (and [serverId] is known). */
    fun withServer(
        url: String,
        serverId: String?,
    ): String {
        if (serverId == null || DeepLink.serverId(url) != null) return url
        val link = DeepLink.parse(url) ?: return url
        // Keep an explicit `view=` the parsed link would not carry (section links).
        return if (link is DeepLink.Section && DeepLink.queryValue(url, "view") != null) url else link.url(server = serverId)
    }

    /** Where a notification about [kind] / [id] opens when it carries no usable link (iOS `fallbackURL`). */
    fun fallbackUrl(
        kind: String?,
        id: String?,
    ): String? {
        return when (kind) {
            "host" -> DeepLink.Section("machines").url
            // What the test push links.
            "test" -> DeepLink.Settings.url
            else -> if (id.isNullOrEmpty()) null else when (kind) {
                "local" -> DeepLink.Local(id).url
                "task" -> DeepLink.Task(id).url
                "agent" -> DeepLink.Agent(id).url
                else -> null
            }
        }
    }

    /**
     * The link a tap should open: [url] when the app can route it, else the fallback for the
     * subject (`optio://local` from a host-offline push is not routable; Machines is), with the
     * server hint added.
     */
    fun tapUrl(
        url: String?,
        kind: String?,
        id: String?,
        serverId: String?,
    ): String? {
        val routable = url?.takeIf { DeepLink.parse(it) != null } ?: fallbackUrl(kind, id) ?: url ?: return null
        return withServer(routable, serverId)
    }

    /** A `VIEW` intent for the app's activity (explicit, so no chooser appears). */
    fun view(
        context: Context,
        url: String,
    ): Intent =
        Intent(Intent.ACTION_VIEW, url.toUri())
            .setPackage(context.packageName)
            .apply { launcherComponent(context)?.let(::setComponent) }
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

    /** Opens [url] (an https PR link) in the browser. */
    fun browser(url: String): Intent = Intent(Intent.ACTION_VIEW, url.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** A notification content / action intent that opens [url] in the app. */
    fun viewPending(
        context: Context,
        url: String,
        requestKey: String,
    ): PendingIntent =
        PendingIntent.getActivity(
            context,
            requestCode(requestKey),
            view(context, url),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /** A notification action intent that opens [url] in the browser. */
    fun browserPending(
        context: Context,
        url: String,
        requestKey: String,
    ): PendingIntent =
        PendingIntent.getActivity(context, requestCode(requestKey), browser(url), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    /** Stable request codes per purpose, so one notification's intents never replace another's. */
    fun requestCode(key: String): Int = key.hashCode()

    private fun launcherComponent(context: Context): ComponentName? =
        runCatching { context.packageManager.getLaunchIntentForPackage(context.packageName)?.component }.getOrNull()
}
