package dev.optio.feature.more

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import dev.optio.core.glance.NotificationPermissionState
import dev.optio.core.network.ApiError
import dev.optio.core.testing.ScreenSize
import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.captureScreens
import dev.optio.core.ui.components.ServerChip
import dev.optio.core.ui.state.LoadState
import dev.optio.feature.more.api.AuthProviderInfo
import dev.optio.feature.more.api.AuthProviders
import dev.optio.feature.more.api.CreatedApiKey
import dev.optio.feature.more.secrets.SecretForm
import dev.optio.feature.more.secrets.SecretsContent
import dev.optio.feature.more.secrets.secretScopes
import dev.optio.feature.more.servers.ServerDraft
import dev.optio.feature.more.servers.ServerEditContent
import dev.optio.feature.more.servers.ServerProbe
import dev.optio.feature.more.servers.ServersContent
import dev.optio.feature.more.settings.AgentSettingsForm
import dev.optio.feature.more.settings.ApiKeysContent
import dev.optio.feature.more.settings.AppIconContent
import dev.optio.feature.more.settings.AppIconOption
import dev.optio.feature.more.settings.CreateApiKeyForm
import dev.optio.feature.more.settings.CreateApiKeySheet
import dev.optio.feature.more.settings.NotificationDevicesContent
import dev.optio.feature.more.settings.NotificationPrefsContent
import dev.optio.feature.more.settings.OptioAgentSettingsContent
import dev.optio.feature.more.settings.SettingsContent
import dev.optio.feature.more.ui.MoreScaffold
import dev.optio.feature.more.ui.MoreSheet
import dev.optio.feature.more.webhooks.NewWebhookForm
import dev.optio.feature.more.webhooks.WebhookDetailContent
import dev.optio.feature.more.webhooks.WebhookDraft
import dev.optio.feature.more.webhooks.WebhooksContent
import dev.optio.feature.more.workspace.CreateWorkspaceForm
import dev.optio.feature.more.workspace.WorkspaceForm
import dev.optio.feature.more.workspace.WorkspaceSettingsContent
import dev.optio.feature.more.workspace.WorkspaceSwitcherContent
import java.time.LocalDate
import org.junit.Test

/**
 * Every More screen with sample data, light and dark (`./gradlew :feature:more:recordRoborazziDebug`
 * → `feature/more/build/outputs/roborazzi/More_*.png`).
 */
class MoreScreenshotsTest : ScreenshotTest() {
    /** A pushed screen's frame, with the back button. */
    @Composable
    private fun Detail(
        title: String,
        actions: @Composable RowScope.() -> Unit = {},
        content: @Composable (PaddingValues) -> Unit,
    ) = MoreScaffold(title, onBack = {}, actions = actions, content = content)

    @Composable
    private fun AddAction() = IconButton(onClick = {}) { Icon(Icons.Outlined.Add, contentDescription = "Add") }

    // region Hub and settings

    @Test
    fun hub() = captureScreens("More_Hub") {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text("More") },
                    actions = { ServerChip(MoreSamples.laptop.shortName, Color(MoreSamples.laptop.color.argb), prominent = true) },
                )
            },
        ) { padding ->
            MoreHubContent(
                user = MoreSamples.user("admin"),
                active = MoreSamples.laptop,
                serverCount = 3,
                workspaceName = "Android DevLab",
                contentPadding = padding,
                onOpen = {},
                onSwitchWorkspace = {},
                onRefresh = {},
                onSignOut = {},
            )
        }
    }

    @Test
    fun settingsAdmin() = captureScreens("More_Settings", size = ScreenSize.TALL) {
        Detail("Settings") { padding ->
            SettingsContent(
                claude = LoadState.Loaded(MoreSamples.claudeAvailable),
                providers = AuthProviders(listOf(AuthProviderInfo("github", "GitHub"), AuthProviderInfo("oidc", "OpenID Connect"))),
                isAdmin = true,
                refreshing = false,
                server = MoreSamples.laptop,
                version = "0.1.0 (1)",
                workspaceId = MoreSamples.WS,
                appIcon = AppIconOption.MIDNIGHT,
                contentPadding = padding,
                onOpen = {},
                onRefresh = {},
                onRefreshClaude = {},
                onSignOut = {},
            )
        }
    }

    @Test
    fun settingsExpiredTokenAuthDisabled() = captureScreens("More_Settings_expired", size = ScreenSize.TALL) {
        Detail("Settings") { padding ->
            SettingsContent(
                claude = LoadState.Loaded(MoreSamples.claudeExpired),
                providers = AuthProviders(emptyList(), authDisabled = true),
                isAdmin = true,
                refreshing = true,
                server = MoreSamples.cluster,
                version = "0.1.0 (1)",
                workspaceId = null,
                appIcon = AppIconOption.DEFAULT,
                contentPadding = padding,
                onOpen = {},
                onRefresh = {},
                onRefreshClaude = {},
                onSignOut = {},
            )
        }
    }

    @Test
    fun apiKeys() = captureScreens("More_ApiKeys") {
        Detail("Access Tokens", actions = { AddAction() }) { padding ->
            ApiKeysContent(LoadState.Loaded(MoreSamples.apiKeys), authDisabled = false, currentToken = "optio_pat_51xyz", contentPadding = padding, onRetry = {}, onRevoke = {})
        }
    }

    @Test
    fun apiKeysAuthDisabled() = captureScreens("More_ApiKeys_authDisabled") {
        Detail("Access Tokens") { padding ->
            ApiKeysContent(LoadState.Idle, authDisabled = true, currentToken = "dev", contentPadding = padding, onRetry = {}, onRevoke = {})
        }
    }

    @Test
    fun newTokenSheet() = captureScreens("More_ApiKeys_new", wholeScreen = true) {
        MoreSheet(title = "New Token", onDismiss = {}, confirmLabel = "Create") {
            CreateApiKeyForm(
                name = "Pixel 10",
                onName = {},
                expires = true,
                onExpires = {},
                expiresOn = LocalDate.of(2026, 12, 21),
                onExpiresOn = {},
            )
        }
    }

    @Test
    fun createdTokenSheet() = captureScreens("More_ApiKeys_created", wholeScreen = true) {
        CreateApiKeySheet(
            created = CreatedApiKey("optio_pat_8d41c0e6a2b94f7a9e3b5c1d0f6a7e2b4c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f", "k", "optio_pat_51", "Pixel 10"),
            creating = false,
            onCreate = { _, _ -> },
            onCancel = {},
            onDone = {},
        )
    }

    @Test
    fun notificationPreferences() = captureScreens("More_NotificationPrefs", size = ScreenSize.TALL) {
        Detail("Notifications") { padding ->
            NotificationPrefsContent(LoadState.Loaded(MoreSamples.preferences), authDisabled = false, contentPadding = padding, onRetry = {}, onToggle = { _, _ -> })
        }
    }

    @Test
    fun notificationDevices() = captureScreens("More_NotificationDevices", size = ScreenSize.TALL) {
        Detail("This phone") { padding ->
            NotificationDevicesContent(
                push = MoreSamples.pushRegistered,
                devices = LoadState.Loaded(MoreSamples.devices),
                servers = listOf(MoreSamples.laptop, MoreSamples.studio),
                activeServerId = MoreSamples.laptop.id,
                authDisabled = false,
                canMutate = true,
                sending = false,
                contentPadding = padding,
                onRefresh = {},
                onRequestPermission = {},
                onOpenSettings = {},
                onRetryRegistration = {},
                onRetryDevices = {},
                onRemove = {},
                onSendTest = {},
                onOpen = {},
            )
        }
    }

    @Test
    fun notificationDevicesWithoutFirebase() = captureScreens("More_NotificationDevices_noFirebase", size = ScreenSize.TALL) {
        Detail("This phone") { padding ->
            NotificationDevicesContent(
                push = MoreSamples.pushNotConfigured,
                devices = LoadState.Loaded(MoreSamples.devices.copy(devices = MoreSamples.devices.devices.take(1))),
                servers = listOf(MoreSamples.laptop),
                activeServerId = MoreSamples.laptop.id,
                authDisabled = false,
                canMutate = true,
                sending = false,
                contentPadding = padding,
                onRefresh = {},
                onRequestPermission = {},
                onOpenSettings = {},
                onRetryRegistration = {},
                onRetryDevices = {},
                onRemove = {},
                onSendTest = {},
                onOpen = {},
            )
        }
    }

    @Test
    fun notificationDevicesDenied() = captureScreens("More_NotificationDevices_denied") {
        Detail("This phone") { padding ->
            NotificationDevicesContent(
                push = MoreSamples.pushRegistered.copy(permission = NotificationPermissionState.DENIED),
                devices = LoadState.Loaded(MoreSamples.devices),
                servers = listOf(MoreSamples.laptop),
                activeServerId = MoreSamples.laptop.id,
                authDisabled = true,
                canMutate = true,
                sending = false,
                contentPadding = padding,
                onRefresh = {},
                onRequestPermission = {},
                onOpenSettings = {},
                onRetryRegistration = {},
                onRetryDevices = {},
                onRemove = {},
                onSendTest = {},
                onOpen = {},
            )
        }
    }

    @Test
    fun agentSettingsAdmin() = captureScreens("More_AgentSettings", size = ScreenSize.TALL) {
        val form = AgentSettingsForm(
            model = "sonnet",
            systemPrompt = "Prefer small PRs. Always run the tests before opening one.",
            confirmWrites = true,
            maxTurns = 20,
            enabledTools = listOf("list_tasks", "create_task", "retry_task", "get_task_logs"),
            reviewAgentType = "codex",
            reviewModel = "gpt-5-codex",
        )
        Detail("Optio Agent") { padding ->
            OptioAgentSettingsContent(LoadState.Loaded(form), form, isAdmin = true, saving = false, saved = false, contentPadding = padding, onRetry = {}, onEdit = {}, onSave = {})
        }
    }

    @Test
    fun agentSettingsMember() = captureScreens("More_AgentSettings_member", size = ScreenSize.TALL) {
        Detail("Optio Agent") { padding ->
            OptioAgentSettingsContent(LoadState.Loaded(AgentSettingsForm()), AgentSettingsForm(), isAdmin = false, saving = false, saved = false, contentPadding = padding, onRetry = {}, onEdit = {}, onSave = {})
        }
    }

    @Test
    fun appIcons() = captureScreens("More_AppIcon", size = ScreenSize.TALL) {
        Detail("App icon") { padding -> AppIconContent(selected = AppIconOption.MIDNIGHT, contentPadding = padding, onSelect = {}) }
    }

    // endregion

    // region Admin

    @Test
    fun secrets() = captureScreens("More_Secrets") {
        Detail("Secrets", actions = { AddAction() }) { padding ->
            SecretsContent(LoadState.Loaded(MoreSamples.secrets), "all", isAdmin = true, contentPadding = padding, onFilter = {}, onRetry = {}, onDelete = {})
        }
    }

    @Test
    fun secretsViewer() = captureScreens("More_Secrets_viewer") {
        Detail("Secrets") { padding ->
            SecretsContent(
                LoadState.Failed(ApiError(403, "Forbidden: requires member role")),
                "all",
                isAdmin = false,
                contentPadding = padding,
                onFilter = {},
                onRetry = {},
                onDelete = {},
            )
        }
    }

    @Test
    fun secretForm() = captureScreens("More_Secrets_add", wholeScreen = true) {
        MoreSheet(title = "Add Secret", onDismiss = {}, confirmLabel = "Save") {
            SecretForm(
                name = "SENTRY_AUTH_TOKEN",
                onName = {},
                value = "sntrys_eyJpYXQiOjE3",
                onValue = {},
                scope = "https://github.com/e2e-org/e2e-repo",
                onScope = {},
                scopes = secretScopes(MoreSamples.secrets.repos, allowGlobal = true),
            )
        }
    }

    @Test
    fun webhooks() = captureScreens("More_Webhooks") {
        Detail("Webhooks", actions = { AddAction() }) { padding ->
            WebhooksContent(LoadState.Loaded(MoreSamples.webhooks), canMutate = true, contentPadding = padding, onRetry = {}, onOpen = {}, onTest = {}, onDelete = {})
        }
    }

    @Test
    fun webhookDetail() = captureScreens("More_WebhookDetail", size = ScreenSize.TALL) {
        Detail("Posts task outcomes to the team's chat bridge") { padding ->
            WebhookDetailContent(
                LoadState.Loaded(MoreSamples.webhookDetail),
                canMutate = true,
                busy = false,
                contentPadding = padding,
                onRetry = {},
                onTest = {},
                onToggle = {},
                onDelete = {},
                initiallyExpanded = setOf("d1"),
            )
        }
    }

    @Test
    fun newWebhook() = captureScreens("More_NewWebhook", size = ScreenSize.TALL) {
        Detail("New Webhook", actions = { TextButton(onClick = {}) { Text("Create") } }) { padding ->
            NewWebhookForm(
                draft = WebhookDraft(url = "https://hooks.slack.com/services/T000/B000/XXXX", description = "#eng-agents", events = setOf("task.failed", "task.needs_attention", "workflow_run.failed")),
                secret = "whsec_123",
                contentPadding = padding,
                onDraft = {},
                onSecret = {},
            )
        }
    }

    @Test
    fun workspaceAdmin() = captureScreens("More_Workspace", size = ScreenSize.TALL) {
        val data = MoreSamples.workspace("admin")
        Detail("Workspace") { padding ->
            WorkspaceSettingsContent(
                state = LoadState.Loaded(data),
                form = WorkspaceForm.of(data.workspace),
                busy = null,
                authDisabled = false,
                contentPadding = padding,
                onRetry = {},
                onForm = {},
                onSave = {},
                onInvite = { _, _, _ -> },
                onChangeRole = { _, _ -> },
                onRemove = {},
                onCreate = {},
                onDelete = {},
            )
        }
    }

    @Test
    fun workspaceMember() = captureScreens("More_Workspace_member") {
        val data = MoreSamples.workspace("member")
        Detail("Workspace") { padding ->
            WorkspaceSettingsContent(
                state = LoadState.Loaded(data),
                form = WorkspaceForm.of(data.workspace),
                busy = null,
                authDisabled = false,
                contentPadding = padding,
                onRetry = {},
                onForm = {},
                onSave = {},
                onInvite = { _, _, _ -> },
                onChangeRole = { _, _ -> },
                onRemove = {},
                onCreate = {},
                onDelete = {},
            )
        }
    }

    @Test
    fun workspaceSwitcher() = captureScreens("More_WorkspaceSwitcher", wholeScreen = true) {
        MoreSheet(title = "Switch Workspace", onDismiss = {}, dismissLabel = null, confirmLabel = "Done") {
            WorkspaceSwitcherContent(
                workspaces = MoreSamples.workspaces,
                loading = false,
                loadError = null,
                authDisabled = false,
                currentId = MoreSamples.WS,
                switchingId = null,
                onSelect = {},
                onCreate = {},
            )
        }
    }

    @Test
    fun createWorkspace() = captureScreens("More_CreateWorkspace", wholeScreen = true) {
        MoreSheet(title = "New Workspace", onDismiss = {}, confirmLabel = "Create") {
            CreateWorkspaceForm(name = "Side project", slug = "side-project", description = "", onName = {}, onSlug = {}, onDescription = {})
        }
    }

    // endregion

    // region Servers

    @Test
    fun servers() = captureScreens("More_Servers") {
        Detail("Servers") { padding ->
            ServersContent(
                servers = listOf(MoreSamples.laptop, MoreSamples.studio, MoreSamples.cluster),
                activeId = MoreSamples.laptop.id,
                probes = mapOf(
                    MoreSamples.laptop.id to ServerProbe(ServerProbe.State.ONLINE, "Ada Admin"),
                    MoreSamples.studio.id to ServerProbe(ServerProbe.State.UNAUTHORIZED),
                ),
                contentPadding = padding,
                onRefresh = {},
                onSelect = {},
                onEdit = {},
                onForget = {},
                onAdd = {},
            )
        }
    }

    @Test
    fun serverEdit() = captureScreens("More_ServerEdit", size = ScreenSize.TALL) {
        Detail("Edit Server", actions = { TextButton(onClick = {}) { Text("Save") } }) { padding ->
            ServerEditContent(
                draft = ServerDraft.of(MoreSamples.studio),
                workspaces = MoreSamples.workspaces,
                contentPadding = padding,
                onDraft = {},
                onForget = {},
            )
        }
    }

    @Test
    fun serverEditInvalidAddress() = captureScreens("More_ServerEdit_invalid", interact = {
        onNodeWithTag("server-edit").performScrollToNode(hasTestTag("server-url"))
    }) {
        Detail("Edit Server", actions = { TextButton(onClick = {}, enabled = false) { Text("Save") } }) { padding ->
            ServerEditContent(
                draft = ServerDraft.of(MoreSamples.laptop).copy(urlText = " "),
                workspaces = null,
                contentPadding = padding,
                onDraft = {},
                onForget = {},
            )
        }
    }

    // endregion

    // region Interactions

    @Test
    fun hubSignOutConfirm() = captureScreens("More_Hub_signOut", wholeScreen = true, interact = {
        onNodeWithTag("more-sign-out").performClick()
    }) {
        Scaffold(topBar = { TopAppBar(title = { Text("More") }) }) { padding ->
            MoreHubContent(
                user = MoreSamples.user("member"),
                active = MoreSamples.studio,
                serverCount = 2,
                workspaceName = null,
                contentPadding = padding,
                onOpen = {},
                onSwitchWorkspace = {},
                onRefresh = {},
                onSignOut = {},
            )
        }
    }

    // endregion
}
