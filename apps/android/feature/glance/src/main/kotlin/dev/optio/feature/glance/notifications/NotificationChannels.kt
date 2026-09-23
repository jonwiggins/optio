package dev.optio.feature.glance.notifications

import android.content.Context
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationManagerCompat

/**
 * One notification channel per alert category (iOS categories become channels, so the user can
 * silence one kind without the others), plus the Watch. Created at process start; the ids are
 * stable (renaming one orphans the user's per-channel settings).
 */
enum class OptioChannel(
    val id: String,
    val title: String,
    val description: String,
    val importance: Int,
) {
    /** A local terminal needs you (`LOCAL_NEEDS_YOU`): heads-up, time-sensitive. */
    NEEDS_YOU(
        "optio.needs_you",
        "Needs you",
        "A terminal on your machine is waiting for a reply or a permission.",
        NotificationManagerCompat.IMPORTANCE_HIGH,
    ),

    /** A task stalled or failed (`TASK_ATTENTION`). */
    TASK_ATTENTION(
        "optio.task_attention",
        "Task needs attention",
        "A task stalled, hit a merge conflict, or failed.",
        NotificationManagerCompat.IMPORTANCE_HIGH,
    ),

    /** A task opened its pull request (`TASK_PR_OPENED`). */
    PR_OPENED(
        "optio.pr_opened",
        "PR opened",
        "A task opened its pull request.",
        NotificationManagerCompat.IMPORTANCE_DEFAULT,
    ),

    /** A persistent agent answered your message (`AGENT_REPLY`). */
    AGENT_REPLY(
        "optio.agent_reply",
        "Agent replies",
        "A persistent agent answered a message you sent.",
        NotificationManagerCompat.IMPORTANCE_HIGH,
    ),

    /** A persistent agent hit its failure limit (`AGENT_FAILED`). */
    AGENT_FAILED(
        "optio.agent_failed",
        "Agent failed",
        "A persistent agent stopped after repeated failed turns.",
        NotificationManagerCompat.IMPORTANCE_HIGH,
    ),

    /** A machine running agents went offline (`HOST_OFFLINE`). */
    HOST_OFFLINE(
        "optio.host_offline",
        "Machine offline",
        "A machine running your agents stopped responding.",
        NotificationManagerCompat.IMPORTANCE_DEFAULT,
    ),

    /** An automation's terminal exited (`LOCAL_EXIT`): silent. */
    LOCAL_EXIT(
        "optio.local_exit",
        "Automation finished",
        "An automation's terminal exited. Delivered quietly.",
        NotificationManagerCompat.IMPORTANCE_LOW,
    ),

    /** The ongoing Watch: silent, never alerts. */
    WATCH(
        "optio.watch",
        "Watch",
        "The ongoing notification: the session waiting on you and what's running. Silent.",
        NotificationManagerCompat.IMPORTANCE_LOW,
    ),

    /** Test pushes and categories this build does not know. */
    OTHER(
        "optio.other",
        "Other",
        "Test notifications and anything else.",
        NotificationManagerCompat.IMPORTANCE_DEFAULT,
    ),
    ;

    companion object {
        /** Creates (or refreshes the names of) every channel. Cheap; safe to call repeatedly. */
        fun createAll(context: Context) {
            val manager = NotificationManagerCompat.from(context)
            manager.createNotificationChannelsCompat(
                entries.map { channel ->
                    NotificationChannelCompat.Builder(channel.id, channel.importance)
                        .setName(channel.title)
                        .setDescription(channel.description)
                        .setShowBadge(channel != WATCH && channel != LOCAL_EXIT)
                        .build()
                },
            )
        }
    }
}
