package dev.optio.feature.library

import androidx.compose.runtime.remember
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import dev.optio.core.network.ApiClient
import dev.optio.core.testing.ScreenSize
import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.ThemeMode
import dev.optio.core.testing.captureScreens
import dev.optio.core.ui.state.LoadState
import dev.optio.feature.library.repos.NewRepoScreen
import dev.optio.feature.library.repos.NewRepoViewModel
import dev.optio.feature.library.repos.NewSharedDirectoryForm
import dev.optio.feature.library.repos.RepoDetail
import dev.optio.feature.library.repos.RepoDetailScreen
import dev.optio.feature.library.repos.RepoDetailViewModel
import dev.optio.feature.library.repos.RepoSettingsForm
import dev.optio.feature.library.repos.RepoSettingsScreen
import dev.optio.feature.library.repos.RepoSettingsViewModel
import dev.optio.feature.library.repos.ReposScreen
import dev.optio.feature.library.repos.ReposViewModel
import dev.optio.feature.library.repos.SharedDirectories
import dev.optio.feature.library.repos.SharedDirectoriesScreen
import dev.optio.feature.library.repos.SharedDirectoriesViewModel
import dev.optio.feature.library.repos.SharedDirectoryDraft
import org.junit.Test

/** Library › Repos, repo detail (+ MCP sheet), settings, shared directories (+ sheet), add repo. */
class RepoScreensTest : ScreenshotTest() {
    private val detail = RepoDetail(
        repo = LibrarySamples.mainRepo,
        connections = listOf(LibrarySamples.httpConnection, LibrarySamples.failingConnection),
        mcpServers = listOf(LibrarySamples.globalMcp, LibrarySamples.repoMcp),
        directories = LibrarySamples.directories,
    )

    @Test
    fun reposList() = captureScreens("Library_Repos", interact = { onNodeWithTag("add-repo").assertIsDisplayed() }) {
        AsUser(Viewer.ADMIN) {
            LibraryHubFrame("Repos") { padding ->
                ReposScreen(padding, vm = remember { ReposViewModel(ApiClient()).apply { seed(LoadState.Loaded(LibrarySamples.repos)) } })
            }
        }
    }

    @Test
    fun reposEmpty() {
        captureScreens("Library_Repos_Empty", interact = { onNodeWithTag("empty-state-action").assertIsDisplayed() }) {
            AsUser(Viewer.ADMIN) {
                LibraryHubFrame("Repos") { padding ->
                    ReposScreen(padding, vm = remember { ReposViewModel(ApiClient()).apply { seed(LoadState.Loaded(emptyList())) } })
                }
            }
        }
        captureScreens("Library_Repos_Empty_Member", modes = listOf(ThemeMode.LIGHT), interact = {
            onNodeWithText("Ask a workspace admin to add one.").assertIsDisplayed()
            onNodeWithTag("add-repo").assertDoesNotExist()
        }) {
            AsUser(Viewer.MEMBER) {
                LibraryHubFrame("Repos") { padding ->
                    ReposScreen(padding, vm = remember { ReposViewModel(ApiClient()).apply { seed(LoadState.Loaded(emptyList())) } })
                }
            }
        }
    }

    private fun detailVm() = RepoDetailViewModel(ApiClient(), "r-main").apply { seed(LoadState.Loaded(detail)) }

    @Test
    fun repoDetailAdmin() = captureScreens("RepoDetail", size = ScreenSize.TALL, interact = {
        onNodeWithTag("edit-settings").assertIsDisplayed()
    }) {
        AsUser(Viewer.ADMIN) { RepoDetailScreen("r-main", vm = remember { detailVm() }) }
    }

    @Test
    fun repoDetailAdminBottom() = captureScreens("RepoDetail_Bottom", interact = {
        onNodeWithTag("repo-detail").performScrollToNode(hasTestTag("remove-repo"))
        onNodeWithTag("remove-repo").assertIsDisplayed()
    }) {
        AsUser(Viewer.ADMIN) { RepoDetailScreen("r-main", vm = remember { detailVm() }) }
    }

    @Test
    fun repoDetailMember() = captureScreens("RepoDetail_Member", size = ScreenSize.TALL, interact = {
        onNodeWithTag("edit-settings").assertDoesNotExist()
        onNodeWithTag("add-mcp").assertDoesNotExist()
        onNodeWithTag("recycle-pods").assertDoesNotExist()
    }) {
        AsUser(Viewer.MEMBER) { RepoDetailScreen("r-main", vm = remember { detailVm() }) }
    }

    @Test
    fun repoMcpSheet() = captureScreens("RepoDetail_McpSheet", wholeScreen = true, interact = {
        onNodeWithTag("sheet-confirm").assertIsDisplayed()
    }) {
        AsUser(Viewer.ADMIN) {
            RepoDetailScreen("r-main", vm = remember { detailVm() })
            McpServerSheet(repoScoped = true, saving = false, onDismiss = {}, onSave = {})
        }
    }

    @Test
    fun mcpFormFilled() = captureScreens("McpServerForm_Filled") {
        ProvideSheetSurface {
            McpServerForm(
                repoScoped = false,
                saving = false,
                onCancel = {},
                onSave = {},
                initial = McpServerDraft(
                    name = "github",
                    command = "npx",
                    args = "-y\n@modelcontextprotocol/server-github",
                    env = "GITHUB_PERSONAL_ACCESS_TOKEN=\${{GITHUB_TOKEN}}",
                ),
            )
        }
    }

    private fun settingsVm() = RepoSettingsViewModel(ApiClient(), "r-main").apply {
        form = RepoSettingsForm.from(LibrarySamples.mainRepo).copy(setupCommands = "pnpm install --frozen-lockfile\npnpm build")
        seed(LoadState.Loaded(LibrarySamples.mainRepo))
    }

    @Test
    fun repoSettingsTop() = captureScreens("RepoSettings", size = ScreenSize.TALL, interact = {
        onNodeWithTag("save").assertIsDisplayed()
    }) {
        RepoSettingsScreen("r-main", vm = remember { settingsVm() })
    }

    @Test
    fun repoSettingsBottom() = captureScreens("RepoSettings_Bottom", size = ScreenSize.TALL, interact = {
        onNodeWithText("Docker-in-Docker").performScrollTo()
    }) {
        RepoSettingsScreen("r-main", vm = remember { settingsVm() })
    }

    @Test
    fun repoSettingsCautious() = captureScreens("RepoSettings_Cautious", modes = listOf(ThemeMode.LIGHT), interact = {
        onNodeWithTag("auto-merge").performScrollTo().assertIsNotEnabled()
    }) {
        RepoSettingsScreen(
            "r-main",
            vm = remember { settingsVm().apply { update { it.withCautiousMode(true) } } },
        )
    }

    private fun directoriesVm() = SharedDirectoriesViewModel(ApiClient(), "r-main").apply {
        seed(LoadState.Loaded(SharedDirectories(LibrarySamples.directories, maxPodInstances = 2)))
        usage["d-npm"] = "1.2G"
    }

    @Test
    fun sharedDirectories() = captureScreens("SharedDirectories", interact = {
        onNodeWithTag("recycle-pods").assertIsDisplayed()
    }) {
        AsUser(Viewer.ADMIN) { SharedDirectoriesScreen("r-main", vm = remember { directoriesVm() }) }
    }

    @Test
    fun sharedDirectoriesMemberAndEmpty() {
        captureScreens("SharedDirectories_Member", modes = listOf(ThemeMode.LIGHT), interact = {
            onNodeWithTag("check-usage").assertDoesNotExist()
            onNodeWithTag("add-directory").assertDoesNotExist()
        }) {
            AsUser(Viewer.MEMBER) { SharedDirectoriesScreen("r-main", vm = remember { directoriesVm() }) }
        }
        captureScreens("SharedDirectories_Empty") {
            AsUser(Viewer.ADMIN) {
                SharedDirectoriesScreen(
                    "r-main",
                    vm = remember { SharedDirectoriesViewModel(ApiClient(), "r-main").apply { seed(LoadState.Loaded(SharedDirectories(emptyList()))) } },
                )
            }
        }
    }

    @Test
    fun sharedDirectorySheet() = captureScreens("SharedDirectories_Sheet", wholeScreen = true, interact = {
        onNodeWithTag("sheet-confirm").assertIsDisplayed()
    }) {
        AsUser(Viewer.ADMIN) {
            SharedDirectoriesScreen("r-main", vm = remember { directoriesVm() })
            LibrarySheet(onDismissRequest = {}) {
                NewSharedDirectoryForm(saving = false, onCancel = {}, onSave = {}, initial = SharedDirectoryDraft().withPreset("pnpm"))
            }
        }
    }

    @Test
    fun sharedDirectoryFormInvalid() = captureScreens("SharedDirectoryForm_Invalid", modes = listOf(ThemeMode.LIGHT), interact = {
        onNodeWithText("Lowercase letters, digits and single hyphens.").assertIsDisplayed()
        onNodeWithTag("sheet-confirm").assertIsNotEnabled()
    }) {
        ProvideSheetSurface {
            NewSharedDirectoryForm(
                saving = false,
                onCancel = {},
                onSave = {},
                initial = SharedDirectoryDraft(name = "My Cache", mountSubPath = "/root/.cache"),
            )
        }
    }

    @Test
    fun newRepoValidated() = captureScreens("NewRepo", interact = {
        onNodeWithTag("validation-ok").assertIsDisplayed()
    }) {
        NewRepoScreen(
            vm = remember {
                NewRepoViewModel(ApiClient()).apply {
                    repoUrl = "https://github.com/acme/api"
                    fullName = "acme/api"
                    defaultBranch = "trunk"
                    isPrivate = true
                    validated = true
                    reviewEnabled = true
                    reviewTrigger = "on_pr"
                    imagePreset = "python"
                }
            },
        )
    }

    @Test
    fun newRepoValidationFailed() = captureScreens("NewRepo_Error", interact = {
        onNodeWithTag("validation-error").assertIsDisplayed()
    }) {
        NewRepoScreen(
            vm = remember {
                NewRepoViewModel(ApiClient()).apply {
                    repoUrl = "https://github.com/e2e-org/not-a-real-repo"
                    fullName = "e2e-org/not-a-real-repo"
                    validationError = "Repository not accessible (401)"
                }
            },
        )
    }

    @Test
    fun newRepoEmpty() = captureScreens("NewRepo_Empty", modes = listOf(ThemeMode.DARK), interact = {
        onNodeWithTag("create-repo").assertIsNotEnabled()
    }) {
        NewRepoScreen(vm = remember { NewRepoViewModel(ApiClient()) })
    }
}
