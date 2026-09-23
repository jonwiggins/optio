package dev.optio.core.navigation.routes

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

// Owner: `:feature:glance` (Agent A9). iOS: Core/LiveActivity/*, Core/Notifications/*,
// Features/More/Settings/NotificationsDevicesView.swift (the push status rows).

/**
 * The Watch and notification settings: the ongoing "Watch" notification (the Android Live
 * Activity), "Keep watching in the background" (an opt-in foreground service holding
 * `/ws/events`), notification permission and push delivery state. Settings screens push it.
 */
@Serializable
data object WatchSettingsRoute : NavKey
