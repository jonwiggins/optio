package dev.optio.feature.library.repos

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.network.ApiClient
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.OptioRowDefaults
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.feature.library.ActionRow
import dev.optio.feature.library.CodeKeyboard
import dev.optio.feature.library.FormColumn
import dev.optio.feature.library.FormTextField
import dev.optio.feature.library.GroupedCard
import dev.optio.feature.library.ImagePresets
import dev.optio.feature.library.LeaveIcon
import dev.optio.feature.library.LibraryActionsViewModel
import dev.optio.feature.library.LibraryScaffold
import dev.optio.feature.library.PickerRow
import dev.optio.feature.library.RepoCreateInput
import dev.optio.feature.library.ReviewTriggers
import dev.optio.feature.library.ScreenEffects
import dev.optio.feature.library.StepperRow
import dev.optio.feature.library.SwitchRow
import dev.optio.feature.library.UrlKeyboard
import dev.optio.feature.library.actionMessage
import dev.optio.feature.library.createRepo
import dev.optio.feature.library.inferFullName
import dev.optio.feature.library.orNull
import dev.optio.feature.library.updateRepo
import dev.optio.feature.library.validateRepo

/**
 * Add a repository (iOS `NewRepoSheet`): paste a URL, validate it against the server (which reads
 * GitHub with the workspace token), pick the defaults, then create + patch like the web wizard.
 */
class NewRepoViewModel(private val api: ApiClient) : LibraryActionsViewModel() {
    var repoUrl by mutableStateOf("")
        internal set
    var fullName by mutableStateOf("")
    var defaultBranch by mutableStateOf("main")
    var isPrivate by mutableStateOf(false)

    var validated by mutableStateOf(false)
        internal set
    var validating by mutableStateOf(false)
        internal set
    var validationError by mutableStateOf<String?>(null)
        internal set

    var imagePreset by mutableStateOf("base")
    var maxConcurrentTasks by mutableStateOf(2)
    var reviewEnabled by mutableStateOf(false)
    var reviewTrigger by mutableStateOf("on_ci_pass")
    var autoResume by mutableStateOf(false)
    var autoMerge by mutableStateOf(false)

    var creating by mutableStateOf(false)
        internal set

    /** Editing the URL invalidates the last validation (iOS `onChange(of: repoUrl)`). */
    fun onRepoUrlChange(value: String) {
        repoUrl = value
        validated = false
        validationError = null
    }

    val canValidate: Boolean
        get() = !validating && repoUrl.isNotBlank()

    /** iOS: Create needs a URL and an owner/repo. */
    val canCreate: Boolean
        get() = !creating && repoUrl.isNotEmpty() && fullName.isNotEmpty()

    fun validate() {
        if (!canValidate) return
        validating = true
        validationError = null
        action {
            try {
                val result = api.validateRepo(repoUrl.trim())
                val info = result.repo
                if (result.valid && info != null) {
                    fullName = info.fullName ?: fullName
                    defaultBranch = info.defaultBranch ?: defaultBranch
                    isPrivate = info.isPrivate ?: isPrivate
                    validated = true
                } else {
                    validationError = result.error ?: "Could not access repository"
                    fillFullNameFromUrl()
                }
            } catch (e: Exception) {
                if (e is kotlin.coroutines.cancellation.CancellationException) throw e
                validationError = e.actionMessage()
                fillFullNameFromUrl()
            } finally {
                validating = false
            }
        }
    }

    /** When validation can't tell, derive owner/repo from the URL so the form stays usable. */
    private fun fillFullNameFromUrl() {
        if (fullName.isEmpty()) inferFullName(repoUrl)?.let { fullName = it }
    }

    /** The options PATCH after creating (iOS: failures here are ignored, the repo exists). */
    fun optionsPatch(): Map<String, Any?> = mapOf(
        "imagePreset" to imagePreset,
        "maxConcurrentTasks" to maxConcurrentTasks,
        "reviewEnabled" to reviewEnabled,
        "reviewTrigger" to reviewTrigger,
        "autoResume" to autoResume,
        "autoMerge" to autoMerge,
    )

    fun create() {
        if (!canCreate) return
        creating = true
        action {
            try {
                val repo = api.createRepo(
                    RepoCreateInput(
                        repoUrl = repoUrl.trim(),
                        fullName = fullName.trim(),
                        defaultBranch = defaultBranch,
                        isPrivate = isPrivate,
                    ),
                )
                orNull { api.updateRepo(repo.id, optionsPatch()) }
                toast("Added ${repo.displayName}.")
                close()
            } finally {
                creating = false
            }
        }
    }
}

@Composable
internal fun NewRepoScreen() {
    val api = LocalApiClient.current
    val vm = viewModel { NewRepoViewModel(api) }
    ScreenEffects(vm.events, onAppear = {})
    LibraryScaffold(
        title = "Add Repository",
        leaveIcon = LeaveIcon.CLOSE,
        actions = {
            TextButton(onClick = vm::create, enabled = vm.canCreate, modifier = Modifier.testTag("create-repo")) {
                if (vm.creating) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Create")
            }
        },
    ) { padding ->
        NewRepoContent(vm, contentPadding = padding)
    }
}

/** The new repo form. Reads and writes [vm]'s snapshot state directly (it is the form's model). */
@Composable
internal fun NewRepoContent(
    vm: NewRepoViewModel,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
) {
    FormColumn(modifier, contentPadding, testTag = "new-repo") {
        GroupedCard(
            header = "Repository",
            footer = "Optio fetches the repo metadata using the workspace GITHUB_TOKEN. If validation fails you can still fill in the details manually.",
        ) {
            FormTextField(
                vm.repoUrl,
                vm::onRepoUrlChange,
                label = "Repository URL",
                placeholder = "https://github.com/owner/repo",
                keyboardOptions = UrlKeyboard,
                modifier = Modifier.testTag("repo-url"),
            )
            InsetDivider()
            ActionRow(
                "Validate",
                onClick = vm::validate,
                icon = Icons.Outlined.Search,
                enabled = vm.canValidate,
                busy = vm.validating,
                modifier = Modifier.testTag("validate-repo"),
            )
            vm.validationError?.let {
                InsetDivider()
                StatusLine(Icons.Outlined.WarningAmber, it, OptioTheme.colors.red, Modifier.testTag("validation-error"))
            }
            if (vm.validated) {
                InsetDivider()
                StatusLine(
                    Icons.Filled.CheckCircle,
                    "${vm.fullName} · ${if (vm.isPrivate) "private" else "public"}",
                    OptioTheme.colors.green,
                    Modifier.testTag("validation-ok"),
                )
            }
        }
        GroupedCard(header = "Details") {
            FormTextField(
                vm.fullName,
                { vm.fullName = it },
                label = "owner/repo",
                keyboardOptions = CodeKeyboard,
                modifier = Modifier.testTag("repo-full-name"),
            )
            InsetDivider()
            FormTextField(vm.defaultBranch, { vm.defaultBranch = it }, label = "Default branch", keyboardOptions = CodeKeyboard)
            InsetDivider()
            SwitchRow("Private repository", vm.isPrivate, { vm.isPrivate = it })
        }
        GroupedCard(header = "Container image") {
            PickerRow("Preset", ImagePresets.all.map { it.id to it.label }, vm.imagePreset, { vm.imagePreset = it })
        }
        GroupedCard(header = "Agent") {
            StepperRow("Max concurrent tasks", vm.maxConcurrentTasks, { vm.maxConcurrentTasks = it }, range = 1..50)
        }
        GroupedCard(header = "PR lifecycle") {
            SwitchRow("Automatic code review", vm.reviewEnabled, { vm.reviewEnabled = it })
            if (vm.reviewEnabled) {
                InsetDivider()
                PickerRow("Trigger", ReviewTriggers.all, vm.reviewTrigger, { vm.reviewTrigger = it })
            }
            InsetDivider()
            SwitchRow("Auto-resume on CI failure / conflicts / review changes", vm.autoResume, { vm.autoResume = it })
            InsetDivider()
            SwitchRow("Auto-merge when checks pass", vm.autoMerge, { vm.autoMerge = it })
        }
    }
}

/** A validation result line (iOS `Label(…, systemImage:)` in footnote, tinted). */
@Composable
private fun StatusLine(icon: ImageVector, text: String, color: Color, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().padding(OptioRowDefaults.ContentPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(18.dp))
        Text(text, style = OptioTheme.type.footnote, color = color)
    }
}
