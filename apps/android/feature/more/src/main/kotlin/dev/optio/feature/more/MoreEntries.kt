package dev.optio.feature.more

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.ApiKeysRoute
import dev.optio.core.navigation.routes.AppIconRoute
import dev.optio.core.navigation.routes.NewWebhookRoute
import dev.optio.core.navigation.routes.NotificationDevicesRoute
import dev.optio.core.navigation.routes.NotificationPrefsRoute
import dev.optio.core.navigation.routes.OptioAgentSettingsRoute
import dev.optio.core.navigation.routes.SecretsRoute
import dev.optio.core.navigation.routes.ServerEditRoute
import dev.optio.core.navigation.routes.ServersRoute
import dev.optio.core.navigation.routes.SettingsRoute
import dev.optio.core.navigation.routes.WebhookDetailRoute
import dev.optio.core.navigation.routes.WebhooksRoute
import dev.optio.core.navigation.routes.WorkspaceSettingsRoute
import dev.optio.feature.more.secrets.SecretsScreen
import dev.optio.feature.more.servers.ServerEditScreen
import dev.optio.feature.more.servers.ServersScreen
import dev.optio.feature.more.settings.ApiKeysScreen
import dev.optio.feature.more.settings.AppIconScreen
import dev.optio.feature.more.settings.NotificationDevicesScreen
import dev.optio.feature.more.settings.NotificationPrefsScreen
import dev.optio.feature.more.settings.OptioAgentSettingsScreen
import dev.optio.feature.more.settings.SettingsScreen
import dev.optio.feature.more.webhooks.NewWebhookScreen
import dev.optio.feature.more.webhooks.WebhookDetailScreen
import dev.optio.feature.more.webhooks.WebhooksScreen
import dev.optio.feature.more.workspace.WorkspaceSettingsScreen

/** Registers `:feature:more`'s routes: settings, admin (secrets, webhooks, workspace) and servers. */
fun EntryProviderScope<NavKey>.moreEntries() {
    entry<SettingsRoute> { SettingsScreen() }
    entry<ApiKeysRoute> { ApiKeysScreen() }
    entry<NotificationPrefsRoute> { NotificationPrefsScreen() }
    entry<NotificationDevicesRoute> { NotificationDevicesScreen() }
    entry<OptioAgentSettingsRoute> { OptioAgentSettingsScreen() }
    entry<AppIconRoute> { AppIconScreen() }
    entry<SecretsRoute> { SecretsScreen() }
    entry<WebhooksRoute> { WebhooksScreen() }
    entry<WebhookDetailRoute> { key -> WebhookDetailScreen(webhookId = key.id) }
    entry<NewWebhookRoute> { NewWebhookScreen() }
    entry<WorkspaceSettingsRoute> { WorkspaceSettingsScreen() }
    entry<ServersRoute> { ServersScreen() }
    entry<ServerEditRoute> { key -> ServerEditScreen(serverId = key.id) }
}
