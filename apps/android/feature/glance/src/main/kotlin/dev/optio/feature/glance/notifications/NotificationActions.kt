package dev.optio.feature.glance.notifications

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.core.app.NotificationCompat
import dev.optio.feature.glance.R

/**
 * What a notification action acts on: the subject ([kind] / [id]) on a server, and where the
 * notification lives ([source], [tag]) so the handler can update it afterwards. Travels in the
 * action's intent extras.
 */
data class ActionTarget(
    val source: Source,
    /** `local` · `task` · `agent` · `host` · `test`. */
    val kind: String,
    val id: String,
    /** The paired server (`ServerProfile.id`); null means "find the one that has it". */
    val serverId: String? = null,
    /** The deep link to open (already routable, with the server hint when known). */
    val url: String? = null,
    val prUrl: String? = null,
    /** The alert's notification tag (unused for the Watch). */
    val tag: String? = null,
    /** The alert category (`LOCAL_NEEDS_YOU`, …). */
    val category: String? = null,
    /** The alert title (re-posting after a reply). */
    val title: String? = null,
) {
    enum class Source { ALERT, WATCH }

    fun toExtras(): Bundle =
        Bundle().apply {
            putString(EXTRA_SOURCE, source.name)
            putString(EXTRA_KIND, kind)
            putString(EXTRA_ID, id)
            putString(EXTRA_SERVER, serverId)
            putString(EXTRA_URL, url)
            putString(EXTRA_PR_URL, prUrl)
            putString(EXTRA_TAG, tag)
            putString(EXTRA_CATEGORY, category)
            putString(EXTRA_TITLE, title)
        }

    companion object {
        private const val EXTRA_SOURCE = "optio.source"
        private const val EXTRA_KIND = "optio.kind"
        private const val EXTRA_ID = "optio.id"
        private const val EXTRA_SERVER = "optio.server"
        private const val EXTRA_URL = "optio.url"
        private const val EXTRA_PR_URL = "optio.prUrl"
        private const val EXTRA_TAG = "optio.tag"
        private const val EXTRA_CATEGORY = "optio.category"
        private const val EXTRA_TITLE = "optio.title"

        fun from(intent: Intent): ActionTarget? {
            val extras = intent.extras ?: return null
            val id = extras.getString(EXTRA_ID) ?: return null
            return ActionTarget(
                source = runCatching { Source.valueOf(extras.getString(EXTRA_SOURCE).orEmpty()) }.getOrDefault(Source.ALERT),
                kind = extras.getString(EXTRA_KIND).orEmpty(),
                id = id,
                serverId = extras.getString(EXTRA_SERVER),
                url = extras.getString(EXTRA_URL),
                prUrl = extras.getString(EXTRA_PR_URL),
                tag = extras.getString(EXTRA_TAG),
                category = extras.getString(EXTRA_CATEGORY),
                title = extras.getString(EXTRA_TITLE),
            )
        }
    }
}

/** Builds notification action buttons and their intents. */
object NotificationActions {
    /** Intent action prefix for [NotificationActionReceiver]. */
    const val INTENT_PREFIX = "dev.optio.glance.action."

    /**
     * The button for [action] on [target]; null when it has nothing to act on (Open PR without a
     * PR, Open without a link). [title] overrides the label ("Message" for an agent on the Watch).
     */
    fun build(
        context: Context,
        action: NotificationAction,
        target: ActionTarget,
        title: String = action.title,
    ): NotificationCompat.Action? {
        val key = "${target.source}|${target.tag ?: target.id}|${action.raw}"
        return when (action) {
            NotificationAction.OPEN -> {
                val url = target.url ?: return null
                NotificationCompat.Action.Builder(0, title, DeepLinkIntents.viewPending(context, url, "open|$key"))
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_NONE)
                    .build()
            }
            NotificationAction.OPEN_PR -> {
                val pr = target.prUrl ?: return target.url?.let { build(context, NotificationAction.OPEN, target, action.title) }
                NotificationCompat.Action.Builder(0, title, DeepLinkIntents.browserPending(context, pr, "pr|$key")).build()
            }
            // Typing into a terminal, resuming or retrying from a locked phone asks to unlock first
            // (iOS `.authenticationRequired`); Later does not.
            NotificationAction.REPLY ->
                NotificationCompat.Action.Builder(R.drawable.ic_stat_optio, title, broadcast(context, action, target, key, mutable = true))
                    .addRemoteInput(AlertNotifier.replyInput(if (target.kind == "agent") "Message ${target.title ?: "the agent"}" else "Your reply"))
                    .setAllowGeneratedReplies(false)
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                    .setShowsUserInterface(false)
                    .setAuthenticationRequired(true)
                    .build()
            NotificationAction.RESUME, NotificationAction.RETRY ->
                NotificationCompat.Action.Builder(0, title, broadcast(context, action, target, key, mutable = false))
                    .setShowsUserInterface(false)
                    .setAuthenticationRequired(true)
                    .build()
            NotificationAction.LATER ->
                NotificationCompat.Action.Builder(0, title, broadcast(context, action, target, key, mutable = false))
                    .setShowsUserInterface(false)
                    .build()
        }
    }

    /** The intent [NotificationActionReceiver] receives for [action] on [target]. */
    fun intent(
        context: Context,
        action: NotificationAction,
        target: ActionTarget,
        key: String = "${target.source}|${target.tag ?: target.id}|${action.raw}",
    ): Intent =
        Intent(context, NotificationActionReceiver::class.java)
            .setAction(INTENT_PREFIX + action.raw)
            // Distinct data per notification + action: PendingIntents never overwrite each other.
            .setData(Uri.parse("optio-notification://action/" + Uri.encode(key)))
            .putExtras(target.toExtras())

    private fun broadcast(
        context: Context,
        action: NotificationAction,
        target: ActionTarget,
        key: String,
        mutable: Boolean,
    ): PendingIntent {
        // A RemoteInput needs a mutable PendingIntent (the system adds the typed text).
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(context, DeepLinkIntents.requestCode(key), intent(context, action, target, key), flags)
    }
}
