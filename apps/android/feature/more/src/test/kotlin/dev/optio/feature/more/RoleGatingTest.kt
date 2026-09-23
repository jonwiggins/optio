package dev.optio.feature.more

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import dev.optio.core.network.ApiError
import dev.optio.core.network.CurrentUser
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.feature.more.secrets.SecretsContent
import dev.optio.feature.more.secrets.SecretsScreen
import dev.optio.feature.more.settings.AgentSettingsForm
import dev.optio.feature.more.settings.ApiKeysContent
import dev.optio.feature.more.settings.AppIconOption
import dev.optio.feature.more.settings.NotificationDevicesContent
import dev.optio.feature.more.settings.NotificationPrefsContent
import dev.optio.feature.more.settings.OptioAgentSettingsContent
import dev.optio.feature.more.settings.SettingsContent
import dev.optio.feature.more.webhooks.WebhookDetailContent
import dev.optio.feature.more.webhooks.WebhooksContent
import dev.optio.feature.more.workspace.WorkspaceForm
import dev.optio.feature.more.workspace.WorkspaceSettingsContent
import dev.optio.feature.more.workspace.WorkspaceSwitcherContent
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * What each role sees (iOS `MoreContext.isAdmin` / `isMember`; the server enforces the same):
 * admins manage secrets in every scope and the workspace; members add their own secrets,
 * webhooks, devices; viewers only read. Auth-disabled servers get a friendly state where the
 * user-scoped routes answer 401.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class RoleGatingTest {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val fake = FakeOptioServerRule()

    private fun show(
        user: CurrentUser? = null,
        content: @Composable () -> Unit,
    ) {
        compose.setContent {
            OptioTheme(darkTheme = false) {
                CompositionLocalProvider(LocalCurrentUser provides user, LocalApiClient provides fake.server.client(), content = content)
            }
        }
    }

    // region Secrets

    private fun secretsScreen(role: String) {
        fake.server.json("/api/secrets", """{"secrets":[{"id":"s1","name":"ANTHROPIC_API_KEY","scope":"global"}]}""")
        fake.server.fixture("/api/repos", "repos.json")
        show(MoreSamples.user(role)) { SecretsScreen() }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("secret-ANTHROPIC_API_KEY").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun secretsAdminAddsInEveryScope() {
        secretsScreen("admin")
        compose.onNodeWithTag("add-secret").performClick()
        compose.onNodeWithTag("scope-global").assertIsDisplayed()
        compose.onNodeWithTag("scope-user").assertIsDisplayed()
        compose.onNodeWithTag("scope-https://github.com/e2e-org/e2e-repo").assertIsDisplayed()
    }

    @Test
    fun secretsMemberAddsOnlyTheirOwn() {
        secretsScreen("member")
        compose.onNodeWithTag("add-secret").performClick()
        compose.onNodeWithTag("scope-user").assertIsDisplayed()
        compose.onAllNodesWithTag("scope-global").assertCountEquals(0)
        compose.onAllNodesWithTag("scope-https://github.com/e2e-org/e2e-repo").assertCountEquals(0)
    }

    @Test
    fun secretsViewerCannotAdd() {
        secretsScreen("viewer")
        compose.onAllNodesWithTag("add-secret").assertCountEquals(0)
    }

    @Test
    fun secretsDeleteIsAdminOnlyExceptYourOwn() {
        show { SecretsContent(LoadState.Loaded(MoreSamples.secrets), "all", isAdmin = false, contentPadding = PaddingValues(), onFilter = {}, onRetry = {}, onDelete = {}) }
        compose.onAllNodesWithTag("delete-ANTHROPIC_API_KEY").assertCountEquals(0)
        compose.onAllNodesWithTag("delete-SENTRY_AUTH_TOKEN").assertCountEquals(0)
        compose.onNodeWithTag("delete-LINEAR_API_KEY").assertIsDisplayed()
    }

    @Test
    fun secretsAdminDeletesAnything() {
        show { SecretsContent(LoadState.Loaded(MoreSamples.secrets), "all", isAdmin = true, contentPadding = PaddingValues(), onFilter = {}, onRetry = {}, onDelete = {}) }
        compose.onNodeWithTag("delete-ANTHROPIC_API_KEY").assertIsDisplayed()
        compose.onNodeWithTag("delete-SENTRY_AUTH_TOKEN").assertIsDisplayed()
    }

    @Test
    fun secretsViewer403IsAFriendlyState() {
        show { SecretsContent(LoadState.Failed(ApiError(403, "Forbidden: requires member role")), "all", isAdmin = false, contentPadding = PaddingValues(), onFilter = {}, onRetry = {}, onDelete = {}) }
        compose.onNodeWithTag("members-only").assertIsDisplayed()
        compose.onNodeWithText("Secrets are only available to workspace members and admins.").assertIsDisplayed()
    }

    // endregion

    // region Webhooks

    @Test
    fun webhooksViewerReadsOnly() {
        show { WebhooksContent(LoadState.Loaded(MoreSamples.webhooks), canMutate = false, contentPadding = PaddingValues(), onRetry = {}, onOpen = {}, onTest = {}, onDelete = {}) }
        compose.onNodeWithTag("webhook-${MoreSamples.webhooks[0].id}").assertIsDisplayed()
        compose.onNodeWithTag("webhook-${MoreSamples.webhooks[0].id}").performTouchInput { longClick() }
        compose.onAllNodesWithText("Send test").assertCountEquals(0)
    }

    @Test
    fun webhooksMemberTestsAndDeletes() {
        var tested = false
        show { WebhooksContent(LoadState.Loaded(MoreSamples.webhooks), canMutate = true, contentPadding = PaddingValues(), onRetry = {}, onOpen = {}, onTest = { tested = true }, onDelete = {}) }
        compose.onNodeWithTag("webhook-${MoreSamples.webhooks[0].id}").performTouchInput { longClick() }
        compose.onNodeWithText("Send test").performClick()
        assertTrue(tested)
    }

    @Test
    fun webhookDetailViewerHasNoActions() {
        show { WebhookDetailContent(LoadState.Loaded(MoreSamples.webhookDetail), canMutate = false, busy = false, contentPadding = PaddingValues(), onRetry = {}, onTest = {}, onToggle = {}, onDelete = {}) }
        compose.onNodeWithTag("webhook-detail").assertIsDisplayed()
        listOf("send-test", "toggle-webhook", "delete-webhook").forEach { compose.onAllNodesWithTag(it).assertCountEquals(0) }
    }

    @Test
    fun webhookDetailMemberConfirmsDelete() {
        var deleted = false
        show { WebhookDetailContent(LoadState.Loaded(MoreSamples.webhookDetail), canMutate = true, busy = false, contentPadding = PaddingValues(), onRetry = {}, onTest = {}, onToggle = {}, onDelete = { deleted = true }) }
        compose.onNodeWithTag("webhook-detail").performScrollToNode(hasTestTag("delete-webhook"))
        compose.onNodeWithTag("delete-webhook").performClick()
        compose.onNodeWithText("Delete this webhook and all delivery history?").assertIsDisplayed()
        compose.onNodeWithTag("confirm").performClick()
        assertTrue(deleted)
    }

    // endregion

    // region Settings

    @Test
    fun agentSettingsReadOnlyForNonAdmins() {
        show { OptioAgentSettingsContent(LoadState.Loaded(AgentSettingsForm()), AgentSettingsForm(), isAdmin = false, saving = false, saved = false, contentPadding = PaddingValues(), onRetry = {}, onEdit = {}, onSave = {}) }
        compose.onNodeWithTag("model-opus").assertIsNotEnabled()
        compose.onNodeWithTag("max-turns-plus").assertIsNotEnabled()
        compose.onAllNodesWithTag("save-settings").assertCountEquals(0)
        compose.onNodeWithTag("agent-settings").performScrollToNode(hasTestTag("review-model"))
        compose.onNodeWithText("Only workspace admins can change these settings.").assertExists()
    }

    @Test
    fun agentSettingsAdminSaves() {
        show { OptioAgentSettingsContent(LoadState.Loaded(AgentSettingsForm()), AgentSettingsForm(), isAdmin = true, saving = false, saved = false, contentPadding = PaddingValues(), onRetry = {}, onEdit = {}, onSave = {}) }
        compose.onNodeWithTag("model-opus").assertIsEnabled()
        compose.onNodeWithTag("agent-settings").performScrollToNode(hasTestTag("save-settings"))
        compose.onNodeWithTag("save-settings").assertIsEnabled()
    }

    @Test
    fun claudeRefreshIsForAdmins() {
        settings(isAdmin = false)
        compose.onAllNodesWithTag("refresh-claude").assertCountEquals(0)
    }

    @Test
    fun claudeRefreshShowsForAdmins() {
        settings(isAdmin = true)
        compose.onNodeWithTag("refresh-claude").assertIsDisplayed()
    }

    private fun settings(isAdmin: Boolean) = show {
        SettingsContent(
            claude = LoadState.Loaded(MoreSamples.claudeAvailable),
            providers = null,
            isAdmin = isAdmin,
            refreshing = false,
            server = MoreSamples.laptop,
            version = "0.1.0 (1)",
            workspaceId = MoreSamples.WS,
            appIcon = AppIconOption.DEFAULT,
            contentPadding = PaddingValues(),
            onOpen = {},
            onRefresh = {},
            onRefreshClaude = {},
            onSignOut = {},
        )
    }

    // endregion

    // region Workspace

    @Test
    fun workspaceAdminEditsInvitesDeletes() {
        workspace("admin")
        compose.onNodeWithTag("ws-name").assertIsDisplayed()
        compose.onNodeWithTag("ws-save").assertIsNotEnabled() // nothing changed yet
        compose.onNodeWithTag("workspace-settings").performScrollToNode(hasTestTag("ws-delete"))
        compose.onNodeWithTag("ws-delete").assertIsDisplayed()
        compose.onAllNodesWithTag("invite-email").assertCountEquals(1)
    }

    @Test
    fun workspaceMemberReadsOnly() {
        workspace("member")
        compose.onAllNodesWithTag("ws-name").assertCountEquals(0)
        compose.onAllNodesWithTag("invite-email").assertCountEquals(0)
        compose.onAllNodesWithTag("ws-delete").assertCountEquals(0)
        compose.onNodeWithText("Only workspace admins can edit workspace settings.").assertIsDisplayed()
        compose.onNodeWithTag("workspace-settings").performScrollToNode(hasTestTag("ws-create"))
        compose.onNodeWithTag("ws-create").assertIsDisplayed() // anyone may create a workspace
    }

    private fun workspace(role: String) {
        val data = MoreSamples.workspace(role)
        show {
            WorkspaceSettingsContent(
                state = LoadState.Loaded(data),
                form = WorkspaceForm.of(data.workspace),
                busy = null,
                authDisabled = false,
                contentPadding = PaddingValues(),
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

    // endregion

    // region Devices

    @Test
    fun devicesViewerCannotRemoveOrTest() {
        devices(canMutate = false)
        compose.onAllNodesWithTag("send-test-push").assertCountEquals(0)
        compose.onAllNodesWithTag("remove-device-57db64ed-20d6-47ed-8613-6b5d32f050ca").assertCountEquals(0)
    }

    @Test
    fun devicesMemberRemovesAndTests() {
        devices(canMutate = true)
        compose.onNodeWithTag("notification-devices").performScrollToNode(hasTestTag("send-test-push"))
        compose.onNodeWithTag("send-test-push").assertIsDisplayed()
        compose.onAllNodesWithTag("remove-device-57db64ed-20d6-47ed-8613-6b5d32f050ca").assertCountEquals(1)
        compose.onNodeWithText("this phone").assertExists()
    }

    private fun devices(canMutate: Boolean) = show {
        NotificationDevicesContent(
            push = MoreSamples.pushRegistered,
            devices = LoadState.Loaded(MoreSamples.devices),
            servers = listOf(MoreSamples.laptop),
            activeServerId = MoreSamples.laptop.id,
            authDisabled = false,
            canMutate = canMutate,
            sending = false,
            contentPadding = PaddingValues(),
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

    // endregion

    // region Auth-disabled servers

    @Test
    fun tokensOnAnAuthDisabledServer() {
        show { ApiKeysContent(LoadState.Idle, authDisabled = true, currentToken = "dev", contentPadding = PaddingValues(), onRetry = {}, onRevoke = {}) }
        compose.onNodeWithTag("auth-disabled").assertIsDisplayed()
    }

    @Test
    fun preferencesOnAnAuthDisabledServer() {
        show { NotificationPrefsContent(LoadState.Idle, authDisabled = true, contentPadding = PaddingValues(), onRetry = {}, onToggle = { _, _ -> }) }
        compose.onNodeWithTag("auth-disabled").assertIsDisplayed()
    }

    @Test
    fun workspacesOnAnAuthDisabledServer() {
        show {
            WorkspaceSwitcherContent(
                workspaces = emptyList(),
                loading = false,
                loadError = ApiError(401, "Authentication required"),
                authDisabled = true,
                currentId = null,
                switchingId = null,
                onSelect = {},
                onCreate = {},
            )
        }
        compose.onNodeWithTag("auth-disabled").assertIsDisplayed()
        compose.onAllNodesWithText("New workspace").assertCountEquals(0)
    }

    // endregion
}
