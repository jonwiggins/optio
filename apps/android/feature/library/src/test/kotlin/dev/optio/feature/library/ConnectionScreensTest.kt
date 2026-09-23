package dev.optio.feature.library

import androidx.compose.runtime.remember
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToNode
import dev.optio.core.network.ApiClient
import dev.optio.core.testing.ScreenSize
import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.ThemeMode
import dev.optio.core.testing.captureScreens
import dev.optio.core.ui.state.LoadState
import dev.optio.feature.library.connections.AccessControl
import dev.optio.feature.library.connections.ConnectionDetail
import dev.optio.feature.library.connections.ConnectionDetailScreen
import dev.optio.feature.library.connections.ConnectionDetailViewModel
import dev.optio.feature.library.connections.ConnectionsCatalog
import dev.optio.feature.library.connections.ConnectionsScreen
import dev.optio.feature.library.connections.ConnectionsViewModel
import dev.optio.feature.library.connections.NewAssignmentForm
import dev.optio.feature.library.connections.NewConnectionData
import dev.optio.feature.library.connections.NewConnectionScreen
import dev.optio.feature.library.connections.NewConnectionViewModel
import org.junit.Test

/** Library › Connections, connection detail (+ assignment sheet) and new connection. */
class ConnectionScreensTest : ScreenshotTest() {
    private val catalog = ConnectionsCatalog(
        connections = LibrarySamples.connections,
        providers = LibrarySamples.providers,
        mcpServers = listOf(LibrarySamples.globalMcp, LibrarySamples.globalMcp.copy(id = "m-off", name = "memory", args = listOf("-y", "@modelcontextprotocol/server-memory"), enabled = false)),
        repos = LibrarySamples.repos,
    )

    private fun hubVm(value: ConnectionsCatalog = catalog) = ConnectionsViewModel(ApiClient()).apply { seed(LoadState.Loaded(value)) }

    @Test
    fun connectionsTop() = captureScreens("Library_Connections", size = ScreenSize.TALL, interact = {
        onNodeWithText("Sentry (prod)").assertIsDisplayed()
    }) {
        AsUser(Viewer.ADMIN) {
            LibraryHubFrame("Connections") { padding -> ConnectionsScreen(padding, vm = remember { hubVm() }) }
        }
    }

    @Test
    fun connectionsBottom() = captureScreens("Library_Connections_Bottom", size = ScreenSize.TALL, interact = {
        onNodeWithTag("connections-list").performScrollToNode(hasTestTag("add-mcp"))
        onNodeWithTag("add-mcp").assertIsDisplayed()
    }) {
        AsUser(Viewer.ADMIN) {
            LibraryHubFrame("Connections") { padding -> ConnectionsScreen(padding, vm = remember { hubVm() }) }
        }
    }

    @Test
    fun connectionsViewer() = captureScreens("Library_Connections_Viewer", size = ScreenSize.TALL, modes = listOf(ThemeMode.LIGHT), interact = {
        onNodeWithTag("add-mcp").assertDoesNotExist()
    }) {
        AsUser(Viewer.VIEWER) {
            LibraryHubFrame("Connections") { padding -> ConnectionsScreen(padding, vm = remember { hubVm() }) }
        }
    }

    @Test
    fun connectionsEmpty() = captureScreens("Library_Connections_Empty", interact = {
        onNodeWithText("No connections yet. Pick a provider below to add one.").assertIsDisplayed()
    }) {
        AsUser(Viewer.ADMIN) {
            LibraryHubFrame("Connections") { padding ->
                ConnectionsScreen(padding, vm = remember { hubVm(ConnectionsCatalog(providers = LibrarySamples.providers)) })
            }
        }
    }

    private fun detailVm(connection: ConnectionRow = LibrarySamples.httpConnection) =
        ConnectionDetailViewModel(ApiClient(), connection.id).apply {
            seed(LoadState.Loaded(ConnectionDetail(connection, connection.assignments.orEmpty(), LibrarySamples.repos)))
        }

    @Test
    fun connectionDetail() = captureScreens("ConnectionDetail", size = ScreenSize.TALL, interact = {
        onNodeWithTag("test-connection").assertIsDisplayed()
    }) {
        AsUser(Viewer.ADMIN) { ConnectionDetailScreen(LibrarySamples.httpConnection.id, vm = remember { detailVm() }) }
    }

    @Test
    fun connectionDetailFailing() = captureScreens("ConnectionDetail_Failing", interact = {
        onNodeWithText("Enable").assertIsDisplayed()
    }) {
        AsUser(Viewer.ADMIN) { ConnectionDetailScreen(LibrarySamples.failingConnection.id, vm = remember { detailVm(LibrarySamples.failingConnection) }) }
    }

    @Test
    fun connectionDetailMemberAndViewer() {
        captureScreens("ConnectionDetail_Member", modes = listOf(ThemeMode.LIGHT), interact = {
            onNodeWithTag("add-assignment").assertIsDisplayed()
            onNodeWithTag("test-connection").assertDoesNotExist()
        }) {
            AsUser(Viewer.MEMBER) { ConnectionDetailScreen(LibrarySamples.filesystemConnection.id, vm = remember { detailVm(LibrarySamples.filesystemConnection) }) }
        }
        captureScreens("ConnectionDetail_Viewer", modes = listOf(ThemeMode.LIGHT), interact = {
            onNodeWithTag("add-assignment").assertDoesNotExist()
        }) {
            AsUser(Viewer.VIEWER) { ConnectionDetailScreen(LibrarySamples.httpConnection.id, vm = remember { detailVm() }) }
        }
    }

    @Test
    fun assignmentSheet() = captureScreens("ConnectionDetail_AssignmentSheet", wholeScreen = true, interact = {
        onNodeWithTag("sheet-confirm").assertIsDisplayed()
    }) {
        AsUser(Viewer.ADMIN) {
            ConnectionDetailScreen(LibrarySamples.httpConnection.id, vm = remember { detailVm() })
            LibrarySheet(onDismissRequest = {}) {
                NewAssignmentForm(
                    repos = LibrarySamples.repos,
                    saving = false,
                    onCancel = {},
                    onSave = {},
                    initial = AccessControl(repoId = "r-mobile", permission = "readwrite").toggling("claude-code", true),
                )
            }
        }
    }

    private fun newVm(provider: ConnectionProviderRow, fill: NewConnectionViewModel.() -> Unit = {}) =
        NewConnectionViewModel(ApiClient(), provider.id).apply {
            seed(LoadState.Loaded(NewConnectionData(provider, LibrarySamples.repos)))
            name = "My ${provider.name}"
            fill()
        }

    @Test
    fun newConnectionHttp() = captureScreens("NewConnection_Http", size = ScreenSize.TALL, interact = {
        onNodeWithTag("add-connection").assertIsDisplayed()
    }) {
        val vm = remember {
            newVm(LibrarySamples.httpProvider) {
                config["baseUrl"] = "https://status.example.com"
                config["authType"] = "bearer"
                config["AUTH_TOKEN"] = "sk-live-123456"
                showAccess = true
                access = AccessControl(repoId = "r-main").toggling("claude-code", true)
            }
        }
        NewConnectionScreen(LibrarySamples.httpProvider.id, vm = vm)
    }

    @Test
    fun newConnectionSlack() = captureScreens("NewConnection_Slack", interact = {
        onNodeWithTag("add-connection").assertIsNotEnabled()
        onNodeWithText("SLACK_BOT_TOKEN").assertIsDisplayed()
    }) {
        val vm = remember { newVm(LibrarySamples.slackProvider) { config["SLACK_BOT_TOKEN"] = "xoxb-secret" } }
        NewConnectionScreen(LibrarySamples.slackProvider.id, vm = vm)
    }
}
