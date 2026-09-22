package dev.optio.feature.more

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.optio.core.navigation.routes.AddServerRoute
import dev.optio.core.navigation.routes.ApiKeysRoute
import dev.optio.core.navigation.routes.SecretsRoute
import dev.optio.core.navigation.routes.ServersRoute
import dev.optio.core.navigation.routes.SettingsRoute
import dev.optio.core.navigation.routes.WebhooksRoute
import dev.optio.core.navigation.routes.WorkspaceSettingsRoute
import dev.optio.core.ui.PlaceholderSection

/**
 * The More hub's content: admin, settings, account (iOS `MoreHubView`). The hub chrome comes
 * from `:app`; apply [contentPadding] to the scrolling container. Stub: Agent A8 builds it.
 */
@Composable
fun MoreScreen(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    PlaceholderSection(
        title = "More",
        contentPadding = contentPadding,
        modifier = modifier,
        samples =
            listOf(
                SettingsRoute,
                ServersRoute,
                AddServerRoute,
                ApiKeysRoute,
                SecretsRoute,
                WebhooksRoute,
                WorkspaceSettingsRoute,
            ),
    )
}
