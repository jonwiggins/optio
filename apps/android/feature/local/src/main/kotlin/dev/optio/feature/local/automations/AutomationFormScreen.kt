package dev.optio.feature.local.automations

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.model.LocalAgentKind
import dev.optio.core.model.LocalAgentSessionMode
import dev.optio.core.model.LocalBlueprint
import dev.optio.core.model.LocalBlueprintSpawnMode
import dev.optio.core.model.LocalHost
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.LocalAutomationRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.SectionHeader
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.state.ErrorText
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.mono
import dev.optio.core.ui.toast.LocalToaster
import dev.optio.feature.local.api.createLocalBlueprint
import dev.optio.feature.local.api.getLocalBlueprint
import dev.optio.feature.local.api.listLocalHosts
import dev.optio.feature.local.api.updateLocalBlueprint
import dev.optio.feature.local.model.LocalPresentation
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

/** New / Edit automation: the hosts for the pickers, the automation being edited, and the save. */
class AutomationFormViewModel(
    private val api: ApiClient,
    val automationId: String?,
) : ViewModel() {
    data class Loaded(val hosts: List<LocalHost>, val existing: LocalBlueprint?)

    sealed interface Event {
        /** Saved: [created] is true for a new automation (the screen then opens it). */
        data class Saved(val automation: LocalBlueprint, val created: Boolean) : Event
    }

    private val _loaded = MutableStateFlow<LoadState<Loaded>>(LoadState.Loading())
    val loaded: StateFlow<LoadState<Loaded>> = _loaded.asStateFlow()

    private val _form = MutableStateFlow(AutomationForm())
    val form: StateFlow<AutomationForm> = _form.asStateFlow()

    private val _saving = MutableStateFlow(false)
    val saving: StateFlow<Boolean> = _saving.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val eventChannel = Channel<Event>(Channel.BUFFERED)
    val events = eventChannel.receiveAsFlow()

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            _loaded.value = LoadState.Loading(_loaded.value.value)
            _loaded.value =
                try {
                    coroutineScope {
                        val hosts = async { runCatching { api.listLocalHosts() }.getOrDefault(emptyList()) }
                        val existing = automationId?.let { id -> async { api.getLocalBlueprint(id) } }
                        val bp = existing?.await()
                        if (bp != null) _form.value = AutomationForm.from(bp)
                        LoadState.Loaded(Loaded(hosts.await(), bp))
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    LoadState.Failed(e)
                }
        }
    }

    fun update(change: (AutomationForm) -> AutomationForm) {
        _form.value = change(_form.value)
        _error.value = null
    }

    fun save() {
        val form = _form.value
        if (!form.canSave || _saving.value) return
        viewModelScope.launch {
            _saving.value = true
            _error.value = null
            try {
                val id = automationId
                val saved = if (id == null) api.createLocalBlueprint(form.body(editing = false)) else api.updateLocalBlueprint(id, form.body(editing = true))
                eventChannel.send(Event.Saved(saved, created = id == null))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _error.value = ErrorText.humanize(e, "automation")
            } finally {
                _saving.value = false
            }
        }
    }
}

/** `LocalAutomationFormRoute`: New automation / Edit automation (iOS `BlueprintFormSheet`, a full screen here). */
@Composable
fun AutomationFormScreen(automationId: String?) {
    val api = LocalApiClient.current
    val vm: AutomationFormViewModel = viewModel(key = "local-automation-form-${automationId ?: "new"}") { AutomationFormViewModel(api, automationId) }
    val navigator = LocalNavigator.current
    val toaster = LocalToaster.current
    LaunchedEffect(vm) {
        vm.events.collect { event ->
            when (event) {
                is AutomationFormViewModel.Event.Saved -> {
                    toaster.success(if (event.created) "Automation created" else "Saved")
                    navigator.pop()
                    if (event.created) navigator.push(LocalAutomationRoute(event.automation.id))
                }
            }
        }
    }
    val loaded by vm.loaded.collectAsStateWithLifecycle()
    val form by vm.form.collectAsStateWithLifecycle()
    val saving by vm.saving.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    AutomationFormContent(
        editing = automationId != null,
        loaded = loaded,
        form = form,
        saving = saving,
        error = error,
        onChange = vm::update,
        onSave = vm::save,
        onRetry = vm::load,
        onBack = navigator::pop,
    )
}

@Composable
internal fun AutomationFormContent(
    editing: Boolean,
    loaded: LoadState<AutomationFormViewModel.Loaded>,
    form: AutomationForm,
    saving: Boolean,
    error: String?,
    onChange: ((AutomationForm) -> AutomationForm) -> Unit,
    onSave: () -> Unit,
    onRetry: () -> Unit,
    onBack: () -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.testTag("back")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Cancel")
                    }
                },
                title = { Text(if (editing) "Edit automation" else "New automation") },
                actions = {
                    TextButton(onClick = onSave, enabled = form.canSave && !saving && loaded.value != null, modifier = Modifier.testTag("automation-save")) {
                        if (saving) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text(if (editing) "Save" else "Create")
                    }
                },
            )
        },
    ) { padding ->
        val data = loaded.value
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                data != null -> FormBody(data.hosts, form, error, onChange)
                loaded is LoadState.Failed -> ErrorRow(error = loaded.error, what = "automation", retry = onRetry)
                else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp) }
            }
        }
    }
}

@Composable
private fun FormBody(
    hosts: List<LocalHost>,
    form: AutomationForm,
    error: String?,
    onChange: ((AutomationForm) -> AutomationForm) -> Unit,
) {
    val host = hosts.firstOrNull { it.id == form.hostId }
    Column(
        Modifier
            .fillMaxSize()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .readableWidth()
            .padding(horizontal = Spacing.l)
            .padding(bottom = Spacing.xl)
            .testTag("automation-form"),
        verticalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        OutlinedTextField(
            value = form.name,
            onValueChange = { v -> onChange { it.copy(name = v.take(100)) } },
            label = { Text("Name") },
            placeholder = { Text("e.g. triage ticket") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.m).testTag("form-name"),
        )
        OutlinedTextField(
            value = form.description,
            onValueChange = { v -> onChange { it.copy(description = v.take(2000)) } },
            label = { Text("Description (optional)") },
            modifier = Modifier.fillMaxWidth(),
        )
        Picker(
            label = "Host",
            value = host?.name ?: "Any online host",
            options = listOf("" to "Any online host") + hosts.map { it.id to it.name },
            onPick = { id -> onChange { it.copy(hostId = id, dir = "") } },
            tag = "form-host",
        )

        SectionHeader("Where", contentPadding = PaddingValues(top = Spacing.s))
        Segmented(AutomationForm.Location.entries.map { it to it.label }, form.location) { loc -> onChange { it.copy(location = loc) } }
        when (form.location) {
            AutomationForm.Location.DIR ->
                if (host != null && host.dirs.isNotEmpty()) {
                    Picker(
                        label = "Directory",
                        value = form.dir.ifEmpty { "Pick a directory…" },
                        options = host.dirs.map { it.path to (LocalPresentation.shortDir(it.path) ?: it.path) },
                        onPick = { path -> onChange { it.copy(dir = path) } },
                        mono = true,
                        tag = "form-dir",
                    )
                } else {
                    MonoField("Directory", form.dir, "/absolute/path/on/the/host", "form-dir") { v -> onChange { it.copy(dir = v) } }
                }
            AutomationForm.Location.REPO -> {
                MonoField("Repo URL", form.repoUrl, "https://github.com/owner/repo", "form-repo") { v -> onChange { it.copy(repoUrl = v) } }
                Hint("Resolved against the host's dir list.")
            }
            AutomationForm.Location.EVENT ->
                Hint("A GitHub event runs in the checkout of the event's repo (and is skipped on machines without one); anything else runs in the host's first directory.")
        }

        SectionHeader(if (form.agent == null) "Command template" else "Prompt template", contentPadding = PaddingValues(top = Spacing.s))
        Picker(
            label = "Run as",
            value = form.agent?.let(LocalPresentation::agentLabel) ?: "None (shell)",
            options = listOf("" to "None (shell)") + LocalPresentation.agents.map { it.raw to LocalPresentation.agentLabel(it) },
            onPick = { raw -> onChange { it.copy(agent = if (raw.isEmpty()) null else LocalAgentKind.fromRaw(raw)) } },
            tag = "form-agent",
        )
        OutlinedTextField(
            value = form.commandTemplate,
            onValueChange = { v -> onChange { it.copy(commandTemplate = v.take(4000)) } },
            placeholder = { Text(AutomationForm.placeholder(form.agent), style = OptioTheme.type.body.mono()) },
            textStyle = OptioTheme.type.body.mono(),
            minLines = 3,
            maxLines = 10,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth().testTag("form-template"),
        )
        Hint(AutomationForm.hint(form.agent))

        if (form.agent != null) {
            SectionHeader("Then", contentPadding = PaddingValues(top = Spacing.s))
            Segmented(
                listOf(LocalAgentSessionMode.INTERACTIVE to "Keep the session open", LocalAgentSessionMode.HEADLESS to "Exit when done"),
                form.sessionMode,
            ) { mode -> onChange { it.copy(sessionMode = mode) } }
        }

        SectionHeader("Spawn mode", contentPadding = PaddingValues(top = Spacing.s))
        Column {
            listOf(
                LocalBlueprintSpawnMode.HOLD to "hold — create pending, start with one tap",
                LocalBlueprintSpawnMode.AUTO to "auto — spawn immediately",
            ).forEach { (mode, label) ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .selectable(selected = form.spawnMode == mode, role = Role.RadioButton) { onChange { it.copy(spawnMode = mode) } }
                        .padding(vertical = 4.dp)
                        .testTag("form-spawn-${mode.raw}"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = form.spawnMode == mode, onClick = null)
                    Text(label, style = OptioTheme.type.body, modifier = Modifier.padding(start = Spacing.s))
                }
            }
        }
        val shown = error ?: form.problem
        if (shown != null) {
            Text(shown, style = OptioTheme.type.footnote, color = if (error != null) OptioTheme.colors.red else OptioTheme.colors.secondaryLabel, modifier = Modifier.testTag("form-problem"))
        }
    }
}

@Composable
private fun Hint(text: String) {
    Text(text, style = OptioTheme.type.caption, color = OptioTheme.colors.secondaryLabel)
}

@Composable
private fun MonoField(
    label: String,
    value: String,
    placeholder: String,
    tag: String,
    onChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        placeholder = { Text(placeholder, style = OptioTheme.type.body.mono()) },
        singleLine = true,
        textStyle = OptioTheme.type.body.mono(),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
        modifier = Modifier.fillMaxWidth().testTag(tag),
    )
}

@Composable
private fun <T> Segmented(
    options: List<Pair<T, String>>,
    selection: T,
    onSelect: (T) -> Unit,
) {
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        options.forEachIndexed { index, (value, label) ->
            SegmentedButton(
                selected = selection == value,
                onClick = { onSelect(value) },
                shape = SegmentedButtonDefaults.itemShape(index, options.size),
                icon = {},
                modifier = Modifier.testTag("segment-$label"),
            ) { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
    }
}

@Composable
private fun Picker(
    label: String,
    value: String,
    options: List<Pair<String, String>>,
    onPick: (String) -> Unit,
    mono: Boolean = false,
    tag: String,
) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }) {
        OutlinedTextField(
            value = value,
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            singleLine = true,
            textStyle = if (mono) OptioTheme.type.body.mono() else OptioTheme.type.body,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
            modifier = Modifier.fillMaxWidth().menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable).testTag(tag),
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { (key, text) ->
                DropdownMenuItem(
                    text = { Text(text, style = if (mono) OptioTheme.type.body.mono() else OptioTheme.type.body) },
                    onClick = {
                        onPick(key)
                        open = false
                    },
                )
            }
        }
    }
}
