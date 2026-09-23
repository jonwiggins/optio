package dev.optio.feature.library.connections

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.OptioRowDefaults
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.feature.library.ChipCloud
import dev.optio.feature.library.CodeKeyboard
import dev.optio.feature.library.ConnectionCreateInput
import dev.optio.feature.library.ConnectionProviderRow
import dev.optio.feature.library.FormTextField
import dev.optio.feature.library.GroupedCard
import dev.optio.feature.library.LeaveIcon
import dev.optio.feature.library.LibraryForm
import dev.optio.feature.library.LibraryScaffold
import dev.optio.feature.library.LibraryViewModel
import dev.optio.feature.library.NoteRow
import dev.optio.feature.library.PickerRow
import dev.optio.feature.library.RepoRow
import dev.optio.feature.library.ScreenEffects
import dev.optio.feature.library.libraryViewModel
import dev.optio.feature.library.SecretKeyboard
import dev.optio.feature.library.createConnection
import dev.optio.feature.library.listConnectionProviders
import dev.optio.feature.library.listOrEmpty
import dev.optio.feature.library.listRepos
import dev.optio.feature.library.providerIcon
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.Job

/** The provider being configured and the repos access control can pick from. */
data class NewConnectionData(
    val provider: ConnectionProviderRow,
    val repos: List<RepoRow> = emptyList(),
)

/**
 * Create a connection for a catalogue provider (iOS `NewConnectionSheet`). Config fields come from
 * the provider's JSON-Schema `configSchema`; values of `format: "secret"` fields live only in this
 * ViewModel's memory (never saved state) until the request is sent, and are dropped after it.
 */
class NewConnectionViewModel(private val api: ApiClient, val providerId: String) : LibraryViewModel<NewConnectionData>() {
    var name by mutableStateOf("")

    /** Typed config values by schema key. */
    val config = mutableStateMapOf<String, String>()

    /** Secret fields currently shown in clear text. */
    val revealed = mutableStateMapOf<String, Boolean>()

    var showAccess by mutableStateOf(false)
    var access by mutableStateOf(AccessControl())

    var saving by mutableStateOf(false)
        private set

    private var named = false

    override suspend fun fetch(): NewConnectionData = coroutineScope {
        val repos = async { listOrEmpty { api.listRepos() } }
        val provider = api.listConnectionProviders().firstOrNull { it.id == providerId }
            ?: throw ApiError(ApiError.NOT_FOUND, "Connection provider not found")
        // iOS: the name starts as "My <provider>".
        if (!named) {
            if (name.isEmpty()) provider.name?.let { name = "My $it" }
            named = true
        }
        NewConnectionData(provider, repos.await())
    }

    /** iOS `canSave`: a name, and every required config field filled. */
    fun canSave(provider: ConnectionProviderRow): Boolean =
        !saving && name.isNotBlank() && provider.configFields.filter { it.required }.all { !config[it.key].isNullOrEmpty() }

    fun input(provider: ConnectionProviderRow): ConnectionCreateInput = ConnectionCreateInput(
        providerId = provider.id,
        name = name.trim(),
        config = config.filterValues { it.isNotEmpty() }.toMap(),
        assignments = listOf(access.assignment()),
    )

    fun toggleReveal(key: String) {
        revealed[key] = revealed[key] != true
    }

    fun save(): Job? {
        val provider = state.value.value?.provider ?: return null
        if (!canSave(provider)) return null
        saving = true
        return action {
            try {
                val created = api.createConnection(input(provider))
                config.clear()
                toast("Added “${created.name ?: name.trim()}”.")
                close()
            } finally {
                saving = false
            }
        }
    }
}

@Composable
internal fun NewConnectionScreen(
    providerId: String,
    vm: NewConnectionViewModel = libraryViewModel { NewConnectionViewModel(it, providerId) },
) {
    val state by vm.state.collectAsStateWithLifecycle()
    ScreenEffects(vm.events, onAppear = vm::loadOnce)
    val provider = state.value?.provider
    LibraryScaffold(
        title = "Add Connection",
        leaveIcon = LeaveIcon.CLOSE,
        actions = {
            TextButton(
                onClick = vm::save,
                enabled = provider != null && vm.canSave(provider),
                modifier = Modifier.testTag("add-connection"),
            ) {
                if (vm.saving) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Add")
            }
        },
    ) { padding ->
        NewConnectionContent(
            state = state,
            name = vm.name,
            onNameChange = { vm.name = it },
            config = vm.config,
            onConfigChange = { key, value -> vm.config[key] = value },
            revealed = vm.revealed,
            onToggleReveal = vm::toggleReveal,
            showAccess = vm.showAccess,
            onShowAccessChange = { vm.showAccess = it },
            access = vm.access,
            onAccessChange = { vm.access = it },
            onRetry = vm::refresh,
            contentPadding = padding,
        )
    }
}

/** The new connection form (stateless). */
@Composable
internal fun NewConnectionContent(
    state: LoadState<NewConnectionData>,
    name: String,
    onNameChange: (String) -> Unit,
    config: Map<String, String>,
    onConfigChange: (String, String) -> Unit,
    revealed: Map<String, Boolean>,
    onToggleReveal: (String) -> Unit,
    showAccess: Boolean,
    onShowAccessChange: (Boolean) -> Unit,
    access: AccessControl,
    onAccessChange: (AccessControl) -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
) {
    LibraryForm(state, what = "connection provider", onRetry = onRetry, modifier = modifier, contentPadding = contentPadding, testTag = "new-connection") { data ->
        val provider = data.provider
        val colors = OptioTheme.colors
        GroupedCard {
            Row(
                Modifier.fillMaxWidth().padding(OptioRowDefaults.ContentPadding),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Icon(providerIcon(provider.icon), contentDescription = null, tint = colors.accent, modifier = Modifier.size(24.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(provider.name ?: provider.slug.orEmpty(), style = OptioTheme.type.headline, color = colors.label)
                    provider.description?.let { Text(it, style = OptioTheme.type.caption, color = colors.secondaryLabel) }
                }
            }
            InsetDivider()
            FormTextField(name, onNameChange, label = "Connection name", modifier = Modifier.testTag("connection-name"))
        }

        val fields = provider.configFields
        if (fields.isNotEmpty()) {
            GroupedCard(header = "Configuration") {
                fields.forEachIndexed { index, field ->
                    if (index > 0) InsetDivider()
                    val value = config[field.key].orEmpty()
                    if (field.options.isNotEmpty()) {
                        PickerRow(
                            label = field.title + if (field.required) " *" else "",
                            options = listOf("" to "Not set") + field.options.map { it to it },
                            selection = value,
                            onSelect = { onConfigChange(field.key, it) },
                            modifier = Modifier.testTag("config-${field.key}"),
                        )
                    } else {
                        val shown = revealed[field.key] == true
                        FormTextField(
                            value = value,
                            onValueChange = { onConfigChange(field.key, it) },
                            label = field.title,
                            required = field.required,
                            placeholder = field.placeholder,
                            singleLine = !field.multiline,
                            minLines = if (field.multiline) 3 else 1,
                            mono = field.multiline,
                            keyboardOptions = if (field.isSecret) SecretKeyboard else CodeKeyboard,
                            visualTransformation = if (field.isSecret && !shown) PasswordVisualTransformation() else VisualTransformation.None,
                            trailingIcon = if (field.isSecret) {
                                {
                                    IconButton(onClick = { onToggleReveal(field.key) }, modifier = Modifier.testTag("reveal-${field.key}")) {
                                        Icon(
                                            if (shown) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                            contentDescription = if (shown) "Hide" else "Show",
                                        )
                                    }
                                }
                            } else {
                                null
                            },
                            modifier = Modifier.testTag("config-${field.key}"),
                        )
                    }
                }
            }
        }

        provider.requiredSecrets?.takeIf { it.isNotEmpty() }?.let { secrets ->
            GroupedCard(header = "Required secrets") {
                ChipCloud(secrets)
                NoteRow("These must exist under Secrets for agents to use this connection.")
            }
        }

        GroupedCard(
            footer = if (showAccess) "Leave all agent toggles off to allow every agent type." else "Defaults: all repos · all agents · read only",
        ) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable(role = Role.Button, onClickLabel = if (showAccess) "Collapse" else "Expand") { onShowAccessChange(!showAccess) }
                    .padding(OptioRowDefaults.ContentPadding)
                    .testTag("access-toggle"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Access control", style = OptioTheme.type.body, color = colors.label, modifier = Modifier.weight(1f))
                Icon(
                    if (showAccess) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                    contentDescription = null,
                    tint = colors.tertiaryLabel,
                )
            }
            if (showAccess) {
                InsetDivider()
                AccessControlFields(data.repos, access, onAccessChange)
            }
        }
    }
}
