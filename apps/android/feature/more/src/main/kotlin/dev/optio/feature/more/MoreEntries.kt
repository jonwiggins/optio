package dev.optio.feature.more

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.ApiKeysRoute
import dev.optio.core.navigation.routes.AppIconRoute
import dev.optio.core.navigation.routes.NotificationDevicesRoute
import dev.optio.core.navigation.routes.NotificationPrefsRoute
import dev.optio.core.navigation.routes.OptioAgentSettingsRoute
import dev.optio.core.navigation.routes.SecretsRoute
import dev.optio.core.navigation.routes.ServersRoute
import dev.optio.core.navigation.routes.SettingsRoute
import dev.optio.core.navigation.routes.WebhookDetailRoute
import dev.optio.core.navigation.routes.WebhooksRoute
import dev.optio.core.navigation.routes.WorkspaceSettingsRoute
import dev.optio.core.ui.PlaceholderScreen

/** Registers `:feature:more`'s routes. Stubs: Agent A8 builds settings, admin and servers screens. */
fun EntryProviderScope<NavKey>.moreEntries() {
    entry<SettingsRoute> { key -> PlaceholderScreen(title = "Settings", detail = key.toString()) }
    entry<ApiKeysRoute> { key -> PlaceholderScreen(title = "API keys", detail = key.toString()) }
    entry<NotificationPrefsRoute> { key -> PlaceholderScreen(title = "Notifications", detail = key.toString()) }
    entry<NotificationDevicesRoute> { key -> PlaceholderScreen(title = "Devices", detail = key.toString()) }
    entry<OptioAgentSettingsRoute> { key -> PlaceholderScreen(title = "Optio agent", detail = key.toString()) }
    entry<AppIconRoute> { key -> PlaceholderScreen(title = "App icon", detail = key.toString()) }
    entry<SecretsRoute> { key -> PlaceholderScreen(title = "Secrets", detail = key.toString()) }
    entry<WebhooksRoute> { key -> PlaceholderScreen(title = "Webhooks", detail = key.toString()) }
    entry<WebhookDetailRoute> { key -> PlaceholderScreen(title = "Webhook", detail = key.toString()) }
    entry<WorkspaceSettingsRoute> { key -> PlaceholderScreen(title = "Workspace", detail = key.toString()) }
    entry<ServersRoute> { key -> PlaceholderScreen(title = "Servers", detail = key.toString()) }
}
