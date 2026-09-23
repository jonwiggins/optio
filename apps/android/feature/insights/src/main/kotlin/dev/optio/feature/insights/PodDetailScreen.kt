package dev.optio.feature.insights

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.RestartAlt
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.AdminOnlyState
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.PullRefresh
import dev.optio.core.ui.components.StatusBadge
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.InsightsFormat
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.isForbidden
import dev.optio.core.ui.state.load
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.toast.LocalToaster
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

/** A repo pod (iOS `PodDetailView` state): the record, its tasks, its health events, restart. */
internal class PodDetailViewModel(
    private val api: ApiClient,
    val podId: String,
) : ViewModel() {
    data class Data(val pod: RepoPodDetail, val events: List<PodHealthEvent>)

    sealed interface Event {
        data object Restarted : Event

        data class Failed(val error: Throwable) : Event
    }

    private val _state = MutableStateFlow<LoadState<Data>>(LoadState.Idle)
    val state: StateFlow<LoadState<Data>> = _state.asStateFlow()

    private val _restarting = MutableStateFlow(false)
    val restarting: StateFlow<Boolean> = _restarting.asStateFlow()

    private val _events = Channel<Event>(Channel.BUFFERED)
    val events: Flow<Event> = _events.receiveAsFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch { reload() }
    }

    suspend fun reload() {
        _state.load {
            val pod = api.clusterPod(podId)
            // Only this pod's events (iOS filters the global list by repoPodId).
            val events = runCatching { api.healthEvents(50) }.getOrDefault(emptyList()).filter { it.repoPodId == podId }
            Data(pod, events)
        }
    }

    fun restart() {
        if (_restarting.value) return
        viewModelScope.launch {
            _restarting.value = true
            try {
                api.restartClusterPod(podId)
                _events.send(Event.Restarted)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _events.send(Event.Failed(e))
            } finally {
                _restarting.value = false
            }
        }
    }
}

/** Insights › Cluster › a repo pod (iOS `PodDetailView`, web `/cluster/[id]`). */
@Composable
internal fun PodDetailScreen(podId: String) {
    val api = LocalApiClient.current
    val navigator = LocalNavigator.current
    val toaster = LocalToaster.current
    val model = viewModel(key = "pod-$podId") { PodDetailViewModel(api, podId) }
    val state by model.state.collectAsStateWithLifecycle()
    val restarting by model.restarting.collectAsStateWithLifecycle()
    val confirm = rememberConfirmState()
    LaunchedEffect(model) {
        model.events.collect { event ->
            when (event) {
                PodDetailViewModel.Event.Restarted -> {
                    toaster.success("Pod restarted")
                    navigator.pop()
                }
                is PodDetailViewModel.Event.Failed -> toaster.error(event.error)
            }
        }
    }
    PodDetailContent(
        state = state,
        restarting = restarting,
        canRestart = Roles.isAdmin,
        onBack = navigator::pop,
        onRefresh = model::reload,
        onRetry = model::refresh,
        onRestart = {
            confirm.ask(
                title = "Restart this pod?",
                message = "Active tasks will be failed.",
                confirmLabel = "Restart pod",
                destructive = true,
            ) { model.restart() }
        },
        onOpenTask = { navigator.push(TaskDetailRoute(it)) },
    )
    ConfirmHost(confirm)
}

@Composable
internal fun PodDetailContent(
    state: LoadState<PodDetailViewModel.Data>,
    restarting: Boolean,
    canRestart: Boolean,
    onBack: () -> Unit = {},
    onRefresh: suspend () -> Unit = {},
    onRetry: () -> Unit = {},
    onRestart: () -> Unit = {},
    onOpenTask: (String) -> Unit = {},
) {
    val data = state.value
    Scaffold(
        modifier = Modifier.testTag("pod-detail"),
        containerColor = OptioTheme.colors.page,
        topBar = {
            TopAppBar(
                title = { Text(data?.pod?.podName ?: "Pod", maxLines = 1, overflow = TextOverflow.MiddleEllipsis) },
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.testTag("back")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (canRestart) {
                        IconButton(onClick = onRestart, enabled = !restarting && data != null, modifier = Modifier.testTag("restart-pod")) {
                            if (restarting) {
                                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                            } else {
                                Icon(Icons.Outlined.RestartAlt, contentDescription = "Restart", tint = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(top = padding.calculateTopPadding())) {
            when {
                data != null -> PullRefresh(onRefresh = onRefresh) { PodDetailBody(data, onOpenTask) }
                state is LoadState.Failed -> {
                    if (state.error.isForbidden) {
                        AdminOnlyState(what = "Pod detail", modifier = Modifier.align(Alignment.Center))
                    } else {
                        ErrorRow(error = state.error, what = "the pod", retry = onRetry)
                    }
                }
                else -> CircularProgressIndicator(Modifier.align(Alignment.Center))
            }
        }
    }
}

@Composable
private fun PodDetailBody(
    data: PodDetailViewModel.Data,
    onOpenTask: (String) -> Unit,
) {
    val pod = data.pod
    val now = rememberNow()
    val colors = OptioTheme.colors
    val k8s = pod.k8sPod
    val runtimeState = k8s?.status?.lowercase() ?: pod.state ?: "unknown"
    val k8sTone = ClusterViewModel.statusTone(k8s?.status)
    val stateTone = if (k8sTone == Tone.IDLE) ClusterViewModel.statusTone(pod.state).takeUnless { it == Tone.IDLE } ?: Tone.forState(pod.state) else k8sTone
    LazyColumn(
        modifier = Modifier.fillMaxSize().readableWidth().testTag("pod-detail-body"),
        contentPadding = PaddingValues(top = Spacing.s, bottom = Spacing.xl),
    ) {
        item(key = "record") {
            GroupedSection {
                KeyValueRow("State", null, trailing = { StatusBadge(text = runtimeState, tone = stateTone) })
                Rows(
                    listOfNotNull(
                        "Repo" to InsightsFormat.repoShortName(pod.repoUrl.orEmpty()),
                        pod.repoBranch?.let { "Branch" to it },
                        "Active tasks" to "${pod.activeTaskCount ?: 0}",
                        relative(pod.createdAt, now)?.let { "Created" to it },
                        relative(k8s?.startedAt, now)?.let { "Started" to it },
                        relative(pod.lastTaskAt, now)?.let { "Last task" to it },
                        pod.managedBy?.let { "Managed by" to it },
                        pod.cachePvcName?.let { "Cache PVC" to "$it (${pod.cachePvcState ?: "?"})" },
                    ),
                )
            }
        }
        if (k8s != null) {
            item(key = "k8s") {
                GroupedSection(header = "Kubernetes") {
                    Rows(
                        listOfNotNull(
                            k8s.phase?.let { "Phase" to it },
                            k8s.nodeName?.let { "Node" to it },
                            k8s.ip?.let { "IP" to it },
                            k8s.restarts?.let { "Restarts" to "$it" },
                        ),
                        leadingDivider = false,
                    )
                    k8s.image?.let { image ->
                        if (listOfNotNull(k8s.phase, k8s.nodeName, k8s.ip, k8s.restarts).isNotEmpty()) InsetDivider()
                        Row(Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m), horizontalArrangement = Arrangement.spacedBy(Spacing.m)) {
                            Text("Image", style = OptioTheme.type.body, color = colors.label)
                            Text(
                                image,
                                style = OptioTheme.type.monoCaption,
                                color = colors.secondaryLabel,
                                maxLines = 2,
                                textAlign = TextAlign.End,
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }
            }
        }
        pod.errorMessage?.takeIf { it.isNotEmpty() }?.let { error ->
            item(key = "error") {
                GroupedSection(header = "Error") {
                    Text(error, style = OptioTheme.type.caption, color = colors.red, modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m))
                }
            }
        }
        item(key = "tasks") {
            val tasks = pod.tasks.orEmpty()
            GroupedSection(header = "Tasks (${tasks.size})") {
                if (tasks.isEmpty()) {
                    Text(
                        "No tasks have run on this pod yet.",
                        style = OptioTheme.type.caption,
                        color = colors.secondaryLabel,
                        modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m),
                    )
                }
                tasks.forEachIndexed { index, t ->
                    if (index > 0) InsetDivider()
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable { onOpenTask(t.id) }
                            .padding(horizontal = Spacing.l, vertical = Spacing.m)
                            .testTag("pod-task-${t.id}"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                    ) {
                        StatusBadge(text = t.state ?: "unknown", tone = Tone.forState(t.state))
                        Text(t.title ?: t.id, style = OptioTheme.type.subheadline, color = colors.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        Column(horizontalAlignment = Alignment.End) {
                            t.agentType?.let { Text(agentLabel(it), style = OptioTheme.type.caption2, color = colors.secondaryLabel) }
                            relative(t.createdAt, now)?.let { Text(it, style = OptioTheme.type.caption2, color = colors.secondaryLabel) }
                        }
                    }
                }
            }
        }
        if (data.events.isNotEmpty()) {
            item(key = "health") {
                GroupedSection(header = "Health events") {
                    data.events.forEachIndexed { index, event ->
                        if (index > 0) InsetDivider()
                        HealthEventRow(event, now)
                    }
                }
            }
        }
    }
}

private fun relative(iso: String?, now: Instant): String? = InsightsDates.parse(iso)?.relativeDescription(now)

/** Label / value rows separated by hairlines. */
@Composable
private fun Rows(rows: List<Pair<String, String>>, leadingDivider: Boolean = true) {
    rows.forEachIndexed { index, (label, value) ->
        if (index > 0 || leadingDivider) InsetDivider()
        KeyValueRow(label, value)
    }
}
