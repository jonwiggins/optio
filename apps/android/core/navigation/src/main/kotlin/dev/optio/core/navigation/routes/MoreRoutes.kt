package dev.optio.core.navigation.routes

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

// Owner: `:feature:more` (Agent A8). iOS: Features/More/{MoreHubView,MoreSupport}.swift,
// Settings/*, Secrets/*, Webhooks/*, Workspace/*, Features/Servers/ServersView.swift.

@Serializable
data object SettingsRoute : NavKey

@Serializable
data object ApiKeysRoute : NavKey

@Serializable
data object NotificationPrefsRoute : NavKey

@Serializable
data object NotificationDevicesRoute : NavKey

@Serializable
data object OptioAgentSettingsRoute : NavKey

@Serializable
data object AppIconRoute : NavKey

@Serializable
data object SecretsRoute : NavKey

@Serializable
data object WebhooksRoute : NavKey

@Serializable
data class WebhookDetailRoute(val id: String) : NavKey

@Serializable
data object WorkspaceSettingsRoute : NavKey

/** Paired servers: rename, recolour, forget, add. */
@Serializable
data object ServersRoute : NavKey
