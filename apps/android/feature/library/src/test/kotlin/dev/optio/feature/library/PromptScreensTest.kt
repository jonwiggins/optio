package dev.optio.feature.library

import androidx.compose.runtime.remember
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.testing.ScreenSize
import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.ThemeMode
import dev.optio.core.testing.captureScreens
import dev.optio.core.ui.state.LoadState
import dev.optio.feature.library.prompts.PromptDetailScreen
import dev.optio.feature.library.prompts.PromptDetailViewModel
import dev.optio.feature.library.prompts.PromptEditorScreen
import dev.optio.feature.library.prompts.PromptEditorViewModel
import dev.optio.feature.library.prompts.PromptsContent
import dev.optio.feature.library.prompts.PromptsScreen
import dev.optio.feature.library.prompts.PromptsViewModel
import org.junit.Test

/** Library › Prompts, the prompt detail and the template editor, light and dark. */
class PromptScreensTest : ScreenshotTest() {
    private fun promptsVm(filter: String = "all", templates: List<PromptTemplateRow> = LibrarySamples.prompts) =
        PromptsViewModel(ApiClient()).apply {
            seed(LoadState.Loaded(templates))
            setFilter(filter)
        }

    @Test
    fun promptsList() = captureScreens("Library_Prompts", interact = {
        onNodeWithTag("add-prompt").assertIsDisplayed()
        onNodeWithText("Add a feature flag").assertIsDisplayed()
    }) {
        AsUser(Viewer.MEMBER) {
            LibraryHubFrame("Prompts") { padding -> PromptsScreen(padding, vm = remember { promptsVm() }) }
        }
    }

    @Test
    fun promptsFiltered() = captureScreens("Library_Prompts_Review") {
        AsUser(Viewer.MEMBER) {
            LibraryHubFrame("Prompts") { padding -> PromptsScreen(padding, vm = remember { promptsVm(filter = "review") }) }
        }
    }

    @Test
    fun promptsEmptyKind() = captureScreens("Library_Prompts_EmptyKind", interact = {
        onNodeWithText("No templates of this kind yet.").assertIsDisplayed()
    }) {
        AsUser(Viewer.MEMBER) {
            LibraryHubFrame("Prompts") { padding ->
                PromptsScreen(padding, vm = remember { promptsVm(filter = "job", templates = LibrarySamples.prompts.filter { it.kind != "job" }) })
            }
        }
    }

    @Test
    fun promptsViewer() = captureScreens("Library_Prompts_Viewer", modes = listOf(ThemeMode.LIGHT), interact = {
        onNodeWithTag("add-prompt").assertDoesNotExist()
    }) {
        AsUser(Viewer.VIEWER) {
            LibraryHubFrame("Prompts") { padding -> PromptsScreen(padding, vm = remember { promptsVm() }) }
        }
    }

    @Test
    fun promptsLoadingAndError() {
        captureScreens("Library_Prompts_Loading") {
            LibraryHubFrame("Prompts") { padding ->
                PromptsContent(LoadState.Loading(), "all", {}, {}, {}, null, contentPadding = padding)
            }
        }
        captureScreens("Library_Prompts_Error", interact = { onNodeWithTag("retry").assertIsDisplayed() }) {
            LibraryHubFrame("Prompts") { padding ->
                PromptsContent(LoadState.Failed(ApiError(500, "boom")), "all", {}, {}, {}, null, contentPadding = padding)
            }
        }
    }

    @Test
    fun promptDetail() = captureScreens("PromptDetail", size = ScreenSize.TALL, interact = {
        onNodeWithTag("edit-prompt").assertIsDisplayed()
        onNodeWithTag("rendered").assertIsDisplayed()
    }) {
        val vm = remember {
            PromptDetailViewModel(ApiClient(), LibrarySamples.flagPrompt.id).apply {
                seed(LoadState.Loaded(LibrarySamples.flagPrompt))
                params["flag"] = "dark-mode"
                extraParams = "owner=ada"
                rendered = "Add a feature flag named dark-mode owned by ada, default off, and open a PR."
            }
        }
        AsUser(Viewer.MEMBER) { PromptDetailScreen(LibrarySamples.flagPrompt.id, vm = vm) }
    }

    @Test
    fun promptDetailViewer() = captureScreens("PromptDetail_Viewer", interact = {
        onNodeWithTag("edit-prompt").assertDoesNotExist()
        onNodeWithTag("render-preview").assertDoesNotExist()
    }) {
        val template = LibrarySamples.prompts.first()
        val vm = remember { PromptDetailViewModel(ApiClient(), template.id).apply { seed(LoadState.Loaded(template)) } }
        AsUser(Viewer.VIEWER) { PromptDetailScreen(template.id, vm = vm) }
    }

    @Test
    fun promptEditorNew() = captureScreens("PromptEditor_New", interact = {
        onNodeWithTag("save").assertIsDisplayed()
    }) {
        val vm = remember { PromptEditorViewModel(ApiClient(), id = null).apply { seed(LoadState.Loaded(Unit)) } }
        PromptEditorScreen(id = null, vm = vm)
    }

    @Test
    fun promptEditorEdit() = captureScreens("PromptEditor_Edit") {
        val vm = remember {
            PromptEditorViewModel(ApiClient(), LibrarySamples.flagPrompt.id).apply {
                populate(LibrarySamples.flagPrompt)
                seed(LoadState.Loaded(Unit))
            }
        }
        PromptEditorScreen(id = LibrarySamples.flagPrompt.id, vm = vm)
    }
}
