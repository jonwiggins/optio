package dev.optio.feature.local

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.LaptopMac
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.model.LocalBlueprint
import dev.optio.core.model.LocalHost
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Navigator
import dev.optio.core.navigation.routes.LocalAutomationFormRoute
import dev.optio.core.navigation.routes.LocalAutomationRoute
import dev.optio.core.navigation.routes.LocalHostRoute
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalEventHub
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.SectionHeader
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.cardSurface
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.hub.HubActions
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.toast.LocalToaster
import dev.optio.feature.local.api.LocalTrigger
import dev.optio.feature.local.machines.AUTOMATIONS_FOOTER
import dev.optio.feature.local.machines.AutomationRow
import dev.optio.feature.local.machines.MachineCard
import dev.optio.feature.local.machines.MachinesViewModel
import dev.optio.feature.local.machines.NO_MACHINES_MESSAGE
import dev.optio.feature.local.ui.actionFailure
import kotlinx.coroutines.launch

/**
 * Library › Machines (iOS `MachinesView`, web `/machines`): the machines paired with Optio Local,
 * online state, facts and directories, then the Local automations that fire on them. A machine
 * opens its own page (its terminals); an automation opens its detail; `+` makes a new one.
 */
@Composable
fun MachinesSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    val api = LocalApiClient.current
    val hub = LocalEventHub.current
    val vm: MachinesViewModel = viewModel { MachinesViewModel(api, hub) }
    LifecycleStartEffect(vm) {
        vm.attach()
        onStopOrDispose { vm.detach() }
    }
    val navigator = LocalNavigator.current
    val toaster = LocalToaster.current
    LaunchedEffect(vm) {
        vm.events.collect { event ->
            when (event) {
                is MachinesViewModel.Event.Toast -> toaster.success(event.message)
                is MachinesViewModel.Event.Failed -> toaster.error(actionFailure(event.error, event.verb))
                is MachinesViewModel.Event.Open -> navigator.push(event.route)
            }
        }
    }
    val canMutate = Roles.canMutate
    if (canMutate) {
        HubActions {
            IconButton(onClick = { navigator.push(LocalAutomationFormRoute()) }, modifier = Modifier.testTag("new-automation")) {
                Icon(Icons.Outlined.Add, contentDescription = "New automation")
            }
        }
    }
    val hosts by vm.hosts.collectAsStateWithLifecycle()
    val automations by vm.automations.collectAsStateWithLifecycle()
    val triggers by vm.triggers.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }

    MachinesContent(
        hosts = hosts,
        automations = automations,
        triggers = triggers,
        canMutate = canMutate,
        contentPadding = contentPadding,
        refreshing = refreshing,
        onRefresh = {
            scope.launch {
                refreshing = true
                vm.refresh()
                refreshing = false
            }
        },
        onRetry = vm::reload,
        navigator = navigator,
        onForget = vm::forget,
        onSpawn = vm::spawn,
        onSetEnabled = vm::setEnabled,
        onDelete = vm::delete,
        modifier = modifier,
    )
}

/** The section for given state (screenshots render it without a ViewModel). */
@Composable
internal fun MachinesContent(
    hosts: LoadState<List<LocalHost>>,
    automations: LoadState<List<LocalBlueprint>>,
    triggers: Map<String, List<LocalTrigger>>,
    canMutate: Boolean,
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
    refreshing: Boolean = false,
    onRefresh: () -> Unit = {},
    onRetry: () -> Unit = {},
    navigator: Navigator = Navigator.None,
    onForget: (LocalHost) -> Unit = {},
    onSpawn: (LocalBlueprint) -> Unit = {},
    onSetEnabled: (LocalBlueprint, Boolean) -> Unit = { _, _ -> },
    onDelete: (LocalBlueprint) -> Unit = {},
) {
    val confirm = rememberConfirmState()
    val hostList = hosts.value
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = onRefresh, modifier = modifier.fillMaxSize().testTag("machines")) {
        LazyColumn(Modifier.fillMaxSize().readableWidth(), contentPadding = contentPadding) {
            val error = hosts.errorOrNull
            if (error != null && hostList == null) {
                item { ErrorRow(error = error, what = "machines", retry = onRetry) }
            }
            when {
                hostList == null && error == null -> item { SkeletonRows(count = 3) }
                hostList == null -> Unit
                hostList.isEmpty() ->
                    item {
                        EmptyState(
                            title = "No machines paired",
                            icon = Icons.Outlined.LaptopMac,
                            message = NO_MACHINES_MESSAGE,
                        )
                    }
                else -> {
                    items(hostList, key = { it.id }) { host ->
                        var menu by remember { mutableStateOf(false) }
                        Box(Modifier.padding(horizontal = Spacing.l, vertical = Spacing.xs)) {
                            MachineCard(
                                host = host,
                                onClick = { navigator.push(LocalHostRoute(host.id)) },
                                onLongClick = if (canMutate) ({ menu = true }) else null,
                            )
                            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                DropdownMenuItem(
                                    text = { Text("Forget machine", color = MaterialTheme.colorScheme.error) },
                                    leadingIcon = { Icon(Icons.Outlined.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                                    onClick = {
                                        menu = false
                                        confirm.ask(
                                            title = "Forget “${host.name}”?",
                                            message = "Removes the pairing. Run `optio local up` on the machine to pair it again.",
                                            confirmLabel = "Forget",
                                            destructive = true,
                                        ) { onForget(host) }
                                    },
                                )
                            }
                        }
                    }
                    automationsSection(automations, triggers, hostList, canMutate, navigator, confirm, onSpawn, onSetEnabled, onDelete, onRetry)
                }
            }
        }
    }
    ConfirmHost(confirm)
}

private fun androidx.compose.foundation.lazy.LazyListScope.automationsSection(
    automations: LoadState<List<LocalBlueprint>>,
    triggers: Map<String, List<LocalTrigger>>,
    hosts: List<LocalHost>,
    canMutate: Boolean,
    navigator: Navigator,
    confirm: dev.optio.core.ui.components.ConfirmState,
    onSpawn: (LocalBlueprint) -> Unit,
    onSetEnabled: (LocalBlueprint, Boolean) -> Unit,
    onDelete: (LocalBlueprint) -> Unit,
    onRetry: () -> Unit,
) {
    val list = automations.value
    item {
        SectionHeader("Automations", detail = list?.size?.takeIf { it > 0 }?.toString())
    }
    when {
        list == null && automations is LoadState.Failed ->
            item { ErrorRow(error = automations.error, what = "automations", retry = onRetry) }
        list == null -> item { SkeletonRows(count = 2) }
        list.isEmpty() ->
            item {
                EmptyState(
                    title = "No automations yet",
                    icon = Icons.Outlined.AutoAwesome,
                    message = "An automation runs an agent on your machine when something happens — a schedule, a webhook, a ticket, or a GitHub / Slack / Linear event.",
                    actionTitle = if (canMutate) "New automation" else null,
                    action = if (canMutate) ({ navigator.push(LocalAutomationFormRoute()) }) else null,
                )
            }
        else ->
            item {
                androidx.compose.foundation.layout.Column(Modifier.padding(horizontal = Spacing.l).cardSurface(padding = 0.dp)) {
                    list.forEachIndexed { index, bp ->
                        var menu by remember { mutableStateOf(false) }
                        Box {
                            AutomationRow(
                                automation = bp,
                                triggers = triggers[bp.id].orEmpty(),
                                hosts = hosts,
                                onClick = { navigator.push(LocalAutomationRoute(bp.id)) },
                                onLongClick = if (canMutate) ({ menu = true }) else null,
                            )
                            AutomationMenu(
                                expanded = menu,
                                automation = bp,
                                onDismiss = { menu = false },
                                onRun = { onSpawn(bp) },
                                onEdit = { navigator.push(LocalAutomationFormRoute(bp.id)) },
                                onToggle = { onSetEnabled(bp, !bp.enabled) },
                                onDelete = {
                                    confirm.ask(
                                        title = "Delete automation “${bp.name}” and its triggers?",
                                        message = "Past runs stay.",
                                        confirmLabel = "Delete",
                                        destructive = true,
                                    ) { onDelete(bp) }
                                },
                            )
                        }
                        if (index < list.lastIndex) InsetDivider()
                    }
                }
            }
    }
    item {
        Text(
            AUTOMATIONS_FOOTER,
            style = OptioTheme.type.footnote,
            color = OptioTheme.colors.secondaryLabel,
            modifier = Modifier.padding(start = Spacing.l * 2, end = Spacing.l * 2, top = Spacing.s, bottom = Spacing.l),
        )
    }
}

/** Run now · Edit · Pause / Enable · Delete (iOS swipe actions, web row buttons). */
@Composable
internal fun AutomationMenu(
    expanded: Boolean,
    automation: LocalBlueprint,
    onDismiss: () -> Unit,
    onRun: () -> Unit,
    onEdit: () -> Unit,
    onToggle: () -> Unit,
    onDelete: () -> Unit,
) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        fun pick(action: () -> Unit): () -> Unit =
            {
                onDismiss()
                action()
            }
        // A paused automation can't be run by hand (the server answers "Blueprint is disabled").
        DropdownMenuItem(
            text = { Text(if (automation.enabled) "Run now" else "Run now (paused)") },
            leadingIcon = { Icon(Icons.Outlined.PlayArrow, null) },
            onClick = pick(onRun),
            enabled = automation.enabled,
        )
        DropdownMenuItem(text = { Text("Edit") }, leadingIcon = { Icon(Icons.Outlined.Edit, null) }, onClick = pick(onEdit))
        DropdownMenuItem(
            text = { Text(if (automation.enabled) "Pause" else "Enable") },
            leadingIcon = { Icon(if (automation.enabled) Icons.Outlined.Pause else Icons.Outlined.PlayArrow, null) },
            onClick = pick(onToggle),
        )
        DropdownMenuItem(
            text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
            leadingIcon = { Icon(Icons.Outlined.Delete, null, tint = MaterialTheme.colorScheme.error) },
            onClick = pick(onDelete),
        )
    }
}
