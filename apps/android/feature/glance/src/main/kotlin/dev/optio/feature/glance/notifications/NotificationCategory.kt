package dev.optio.feature.glance.notifications

import androidx.core.app.NotificationCompat
import dev.optio.core.model.PushAlertCategory

/**
 * The alert categories and the actions each one gets (port of iOS
 * `Core/Notifications/NotificationCategories.swift`). The category strings are the wire contract
 * with the API's push payloads (`data.category`), shared with iOS.
 */
enum class NotificationCategory(
    val raw: String,
    /** The channel alerts of this category post on. */
    val channel: OptioChannel,
    /** Actions in button order (Android shows at most three). */
    val actions: List<NotificationAction>,
    /** Still presented (heads-up, sound) while the app is in the foreground (iOS `presentsInForeground`). */
    val presentsInForeground: Boolean,
    /** The Android category (sorting / Do Not Disturb). */
    val androidCategory: String,
) {
    /** A local terminal needs you (`stop` / `notification` / `quiet`). */
    LOCAL_NEEDS_YOU(
        "LOCAL_NEEDS_YOU",
        OptioChannel.NEEDS_YOU,
        listOf(NotificationAction.REPLY, NotificationAction.LATER),
        presentsInForeground = true,
        androidCategory = NotificationCompat.CATEGORY_REMINDER,
    ),

    /** An automation-spawned terminal exited. */
    LOCAL_EXIT(
        "LOCAL_EXIT",
        OptioChannel.LOCAL_EXIT,
        listOf(NotificationAction.OPEN),
        presentsInForeground = false,
        androidCategory = NotificationCompat.CATEGORY_STATUS,
    ),

    /** A local host went offline. */
    HOST_OFFLINE(
        "HOST_OFFLINE",
        OptioChannel.HOST_OFFLINE,
        emptyList(),
        presentsInForeground = false,
        androidCategory = NotificationCompat.CATEGORY_STATUS,
    ),

    /** A Repo Task entered `needs_attention` or `failed`. */
    TASK_ATTENTION(
        "TASK_ATTENTION",
        OptioChannel.TASK_ATTENTION,
        listOf(NotificationAction.RESUME, NotificationAction.RETRY, NotificationAction.OPEN),
        presentsInForeground = true,
        androidCategory = NotificationCompat.CATEGORY_ERROR,
    ),

    /** A Repo Task opened its PR. */
    TASK_PR_OPENED(
        "TASK_PR_OPENED",
        OptioChannel.PR_OPENED,
        listOf(NotificationAction.OPEN_PR),
        presentsInForeground = false,
        androidCategory = NotificationCompat.CATEGORY_STATUS,
    ),

    /** A Persistent Agent replied to a message you sent. */
    AGENT_REPLY(
        "AGENT_REPLY",
        OptioChannel.AGENT_REPLY,
        listOf(NotificationAction.REPLY),
        presentsInForeground = true,
        androidCategory = NotificationCompat.CATEGORY_MESSAGE,
    ),

    /** A Persistent Agent hit its failure limit. */
    AGENT_FAILED(
        "AGENT_FAILED",
        OptioChannel.AGENT_FAILED,
        listOf(NotificationAction.RESUME),
        presentsInForeground = true,
        androidCategory = NotificationCompat.CATEGORY_ERROR,
    ),

    /** `POST /api/notifications/devices/test` and categories this build does not know. */
    TEST(
        "TEST",
        OptioChannel.OTHER,
        emptyList(),
        presentsInForeground = true,
        androidCategory = NotificationCompat.CATEGORY_STATUS,
    ),
    ;

    companion object {
        fun of(raw: String?): NotificationCategory = entries.firstOrNull { it.raw == raw } ?: TEST

        fun of(category: PushAlertCategory): NotificationCategory = of(category.raw)
    }
}

/** Buttons on an alert or the Watch (iOS `NotificationAction`). */
enum class NotificationAction(
    val raw: String,
    val title: String,
) {
    REPLY("REPLY", "Reply"),
    LATER("LATER", "Later"),
    OPEN("OPEN", "Open"),
    RESUME("RESUME", "Resume"),
    RETRY("RETRY", "Retry"),
    OPEN_PR("OPEN_PR", "Open PR"),
    ;

    /** Actions that open something (an activity) rather than calling the API from a receiver. */
    val opensUi: Boolean
        get() = this == OPEN || this == OPEN_PR

    companion object {
        fun of(raw: String?): NotificationAction? = entries.firstOrNull { it.raw == raw }
    }
}
