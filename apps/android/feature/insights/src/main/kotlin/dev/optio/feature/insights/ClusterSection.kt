package dev.optio.feature.insights

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.PodDetailRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.components.AdminOnlyState
import dev.optio.core.ui.components.ChipPicker
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.MonoText
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.PullRefresh
import dev.optio.core.ui.components.RateBar
import dev.optio.core.ui.components.SectionHeader
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.SkeletonStrip
import dev.optio.core.ui.components.StatItem
import dev.optio.core.ui.components.StatStrip
import dev.optio.core.ui.components.StateDot
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.format.InsightsFormat
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import java.time.Instant
import java.util.Locale
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Insights › Cluster (iOS `ClusterModel`): overview, repo pods, health events and version. */
internal class ClusterViewModel(private val api: ApiClient) : ViewModel() {
    enum class Tab(val label: String) {
        PODS("Pods"),
        REPO_PODS("Repo pods"),
        EVENTS("Events"),
        HEALTH("Health"),
        SERVICES("Services"),
    }

    data class State(
        val overview: ClusterOverview? = null,
        val repoPods: List<RepoPodRecord> = emptyList(),
        val healthEvents: List<PodHealthEvent> = emptyList(),
        val version: ClusterVersion? = null,
        /** The overview answered 403: admins only. */
        val forbidden: Boolean = false,
        val error: Throwable? = null,
        val loading: Boolean = true,
        val tab: Tab = Tab.PODS,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun selectTab(tab: Tab) = _state.update { it.copy(tab = tab) }

    /** One refresh (iOS `load`): the overview, then pods and health events unless forbidden. */
    suspend fun load() = coroutineScope {
        val version = async { runCatching { api.clusterVersion() }.getOrNull() }
        var forbidden = false
        try {
            val overview = api.clusterOverview()
            _state.update { it.copy(overview = overview, forbidden = false, error = null) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (e.status == ApiError.FORBIDDEN) {
                forbidden = true
                _state.update { it.copy(forbidden = true) }
            } else {
                _state.update { it.copy(error = e) }
            }
        } catch (e: Exception) {
            _state.update { it.copy(error = e) }
        }
        if (!forbidden) {
            val pods = async { runCatching { api.clusterPods() }.getOrNull() }
            val events = async { runCatching { api.healthEvents(50) }.getOrNull() }
            pods.await()?.let { p -> _state.update { it.copy(repoPods = p) } }
            events.await()?.let { e -> _state.update { it.copy(healthEvents = e) } }
        }
        version.await()?.let { v -> _state.update { it.copy(version = v) } }
        _state.update { it.copy(loading = false) }
    }

    /** Retry / pull to refresh outside the poll. */
    fun refresh() {
        viewModelScope.launch { load() }
    }

    companion object {
        /** The web page's poll interval. */
        val POLL = 8.seconds

        /** Pod / node status → tone (iOS `ClusterView.statusTone`). */
        fun statusTone(status: String?): Tone = when (status.orEmpty()) {
            "Running", "Ready", "ready", "Succeeded" -> Tone.SUCCESS
            "Pending", "provisioning", "ContainerCreating" -> Tone.WORKING
            "ImagePullBackOff", "ErrImagePull", "CrashLoopBackOff", "Error", "error", "Failed", "failed", "NotReady", "OOMKilled" -> Tone.DANGER
            else -> Tone.IDLE
        }
    }
}

/**
 * Insights › Cluster (iOS `ClusterView`, web `/cluster`): nodes with usage, then Pods · Repo pods ·
 * Events · Health · Services. Admins only (a 403 shows "Admins only"); refreshes every 8 s while on
 * screen. Repo pods open their detail.
 */
@Composable
fun ClusterSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    val api = LocalApiClient.current
    val navigator = LocalNavigator.current
    val model = viewModel(key = "insights-cluster") { ClusterViewModel(api) }
    val state by model.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current
    LaunchedEffect(model, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                model.load()
                delay(ClusterViewModel.POLL)
            }
        }
    }
    ClusterContent(
        state = state,
        contentPadding = contentPadding,
        modifier = modifier,
        onRefresh = { model.load() },
        onRetry = model::refresh,
        onTab = model::selectTab,
        onOpenPod = { navigator.push(PodDetailRoute(it)) },
    )
}

@Composable
internal fun ClusterContent(
    state: ClusterViewModel.State,
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
    onRefresh: suspend () -> Unit = {},
    onRetry: () -> Unit = {},
    onTab: (ClusterViewModel.Tab) -> Unit = {},
    onOpenPod: (String) -> Unit = {},
) {
    val overview = state.overview
    val now = rememberNow()
    PullRefresh(onRefresh = onRefresh, modifier = modifier.testTag("cluster")) {
        LazyColumn(Modifier.fillMaxSize().readableWidth(), contentPadding = contentPadding) {
            when {
                state.forbidden -> {
                    item(key = "forbidden") { AdminOnlyState(what = "The cluster view") }
                    item(key = "version") { VersionRow(state.version, Modifier.fillMaxWidth().padding(horizontal = Spacing.l)) }
                }
                overview == null && state.error != null -> item(key = "error") {
                    ErrorRow(error = state.error, what = "the cluster", retry = onRetry)
                }
                overview == null -> item(key = "skeleton") {
                    Column {
                        SkeletonStrip(labels = listOf("Nodes", "Pods", "Agents", "Infra"), modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.s))
                        SkeletonRows()
                    }
                }
                else -> {
                    // The poll failed: the overview on screen is the last good one.
                    state.error?.let { error -> item(key = "stale") { ErrorRow(error = error, what = "the cluster", retry = onRetry) } }
                    clusterRows(overview, state, now, onTab, onOpenPod)
                }
            }
        }
    }
}

private fun LazyListScope.clusterRows(
    ov: ClusterOverview,
    state: ClusterViewModel.State,
    now: Instant,
    onTab: (ClusterViewModel.Tab) -> Unit,
    onOpenPod: (String) -> Unit,
) {
    item(key = "summary") {
        val s = ov.summary
        Column(Modifier.padding(horizontal = Spacing.l, vertical = Spacing.s), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            StatStrip(
                items = listOf(
                    StatItem("Nodes", "${s.readyNodes}/${s.totalNodes}", tone = if (s.readyNodes < s.totalNodes) Tone.DANGER else null),
                    StatItem("Pods", "${s.runningPods}/${s.totalPods}"),
                    StatItem("Agents", s.agentPods),
                    StatItem("Infra", s.infraPods),
                ),
            )
            VersionRow(state.version)
        }
    }
    if (ov.nodes.isNotEmpty()) {
        item(key = "nodes-header") { SectionHeader("Nodes") }
        items(ov.nodes, key = { "node-${it.name}" }) { node -> NodeRow(node, ov.metricsAvailable == true) }
        if (ov.metricsAvailable == false) {
            item(key = "no-metrics") {
                Text(
                    "metrics-server not detected — CPU and memory usage unavailable.",
                    style = OptioTheme.type.footnote,
                    color = OptioTheme.colors.tertiaryLabel,
                    modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.s),
                )
            }
        }
    }
    item(key = "tabs") {
        ChipPicker(
            options = ClusterViewModel.Tab.entries.map { it to it.label },
            selection = state.tab,
            onSelect = onTab,
            modifier = Modifier.padding(top = Spacing.s),
        )
    }
    when (state.tab) {
        ClusterViewModel.Tab.PODS -> {
            if (ov.pods.isEmpty()) item(key = "pods-empty") { EmptyLine("No pods in the optio namespace") }
            items(ov.pods, key = { "pod-${it.name}" }) { pod ->
                val repoPod = ov.repoPods.firstOrNull { it.podName == pod.name }
                PodRow(pod, now, onClick = repoPod?.let { rp -> { onOpenPod(rp.id) } })
                InsetDivider()
            }
        }
        ClusterViewModel.Tab.REPO_PODS -> {
            if (state.repoPods.isEmpty()) item(key = "repo-pods-empty") { EmptyLine("No repo pods") }
            items(state.repoPods, key = { "repo-pod-${it.id}" }) { rp ->
                RepoPodRow(rp, now) { onOpenPod(rp.id) }
                InsetDivider()
            }
        }
        ClusterViewModel.Tab.EVENTS -> {
            if (ov.events.isEmpty()) item(key = "events-empty") { EmptyLine("No recent events") }
            itemsIndexed(ov.events, key = { i, _ -> "event-$i" }) { _, e ->
                OptioRow(
                    title = e.reason ?: "Event",
                    tone = if (e.type == "Warning") Tone.DANGER else null,
                    meta = metaText(e.involvedObject?.let(::mono), (e.count ?: 0).takeIf { it > 1 }?.let { "×$it" }),
                    trailing = InsightsDates.parse(e.lastTimestamp)?.relativeDescription(now),
                    footer = e.message?.let { androidx.compose.ui.text.AnnotatedString(it) },
                    titleMaxLines = 1,
                )
                InsetDivider()
            }
        }
        ClusterViewModel.Tab.HEALTH -> {
            if (state.healthEvents.isEmpty()) item(key = "health-empty") { EmptyLine("No pod health events") }
            items(state.healthEvents, key = { "health-${it.id}" }) { event ->
                HealthEventRow(event, now)
                InsetDivider()
            }
        }
        ClusterViewModel.Tab.SERVICES -> {
            itemsIndexed(ov.services, key = { i, _ -> "service-$i" }) { _, svc ->
                OptioRow(
                    title = svc.name.orEmpty(),
                    meta = metaText(
                        listOf(svc.type, svc.clusterIP?.let(::mono)) +
                            svc.ports.orEmpty().map { p -> mono("${p.port ?: 0}→${p.targetText}/${p.proto.orEmpty()}") },
                    ),
                    titleMaxLines = 1,
                )
                InsetDivider()
            }
        }
    }
}

@Composable
private fun EmptyLine(text: String) {
    Text(
        text,
        style = OptioTheme.type.caption,
        color = OptioTheme.colors.secondaryLabel,
        modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m),
    )
}

/** "Optio dev · 0.5.0 available" (iOS `versionRow`). */
@Composable
private fun VersionRow(version: ClusterVersion?, modifier: Modifier = Modifier) {
    version ?: return
    val colors = OptioTheme.colors
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Optio ${version.current ?: "unknown"}", style = OptioTheme.type.footnote, color = colors.secondaryLabel)
        val latest = version.latest
        when {
            version.updateAvailable == true && latest != null ->
                Text("· $latest available", style = OptioTheme.type.footnote, color = colors.accent)
            latest != null -> Text("· latest $latest", style = OptioTheme.type.footnote, color = colors.tertiaryLabel)
        }
    }
}

@Composable
private fun NodeRow(node: ClusterNode, metrics: Boolean) {
    val colors = OptioTheme.colors
    Column(
        Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.s).testTag("node-${node.name}"),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (!node.isReady) StateDot(Tone.DANGER)
            MonoText(node.name, modifier = Modifier.weight(1f))
            Text(node.kubeletVersion.orEmpty(), style = OptioTheme.type.caption, color = colors.tertiaryLabel)
        }
        val memory = node.memoryUsedGi?.let { String.format(Locale.US, "%.1f / %.1f Gi", it, node.memoryTotalGi ?: 0.0) }
            ?: InsightsFormat.k8sResource(node.memory)
        metaText(cores(node.cpu).let { if (it == "1") "1 core" else "$it cores" }, memory, node.containerRuntime)?.let {
            Text(it, style = OptioTheme.type.footnote, color = colors.secondaryLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (metrics) {
            node.cpuPercent?.let { RateBar(label = "CPU", valueText = "${it.toInt()}%", fraction = it / 100) }
            node.memoryPercent?.let { RateBar(label = "Memory", valueText = "$it%", fraction = it / 100.0) }
        }
    }
}

private fun cores(value: Double?): String = when {
    value == null -> "?"
    value == Math.floor(value) -> value.toLong().toString()
    else -> String.format(Locale.US, "%.1f", value)
}

@Composable
private fun PodRow(pod: ClusterPodInfo, now: Instant, onClick: (() -> Unit)?) {
    val tone = ClusterViewModel.statusTone(pod.status)
    OptioRow(
        title = pod.name,
        tone = tone.takeUnless { it == Tone.SUCCESS },
        meta = metaText(
            pod.status ?: "Unknown",
            if (pod.isOptioManaged == true) "workspace" else null,
            if (pod.isInfra == true) "infra" else null,
            pod.cpuMillicores?.let { "${it}m CPU" },
            pod.memoryMi?.let { "$it Mi" },
            pod.restarts?.takeIf { it > 0 }?.let { counted(it, "restart") },
        ),
        trailing = if (tone == Tone.DANGER) pod.status ?: "Failed" else InsightsDates.parse(pod.startedAt)?.relativeDescription(now),
        trailingTone = if (tone == Tone.DANGER) Tone.DANGER else null,
        footer = pod.shortImage?.let(::mono),
        titleMaxLines = 1,
        onClick = onClick,
        modifier = Modifier.testTag("pod-${pod.name}"),
    )
}

@Composable
private fun RepoPodRow(rp: RepoPodRecord, now: Instant, onClick: () -> Unit) {
    // A healthy `ready` pod is quiet (Tone.forState would read "ready" as needs-you).
    val tone = ClusterViewModel.statusTone(rp.state).takeUnless { it == Tone.IDLE } ?: Tone.forState(rp.state)
    OptioRow(
        title = "${InsightsFormat.repoShortName(rp.repoUrl.orEmpty())} #${rp.instanceIndex ?: 0}",
        tone = tone.takeUnless { it == Tone.SUCCESS },
        meta = metaText(
            (rp.state ?: "unknown").replace('_', ' '),
            "${rp.activeTaskCount ?: 0} active",
            rp.queuedTaskCount?.takeIf { it > 0 }?.let { "$it queued" },
            rp.podName?.let(::mono),
        ),
        trailing = InsightsDates.parse(rp.lastTaskAt)?.let { "last ${it.relativeDescription(now)}" },
        titleMaxLines = 1,
        onClick = onClick,
        modifier = Modifier.testTag("repo-pod-${rp.id}"),
    )
}

/** A pod health event (iOS `HealthEventRow`): restarts are working, healthy / cleaned quiet, the rest red. */
@Composable
internal fun HealthEventRow(event: PodHealthEvent, now: Instant) {
    val tone = when (event.eventType.orEmpty()) {
        "healthy", "orphan_cleaned" -> null
        "restarted" -> Tone.WORKING
        else -> Tone.DANGER
    }
    OptioRow(
        title = (event.eventType ?: "event").replace('_', ' ').split(' ').joinToString(" ") { w ->
            w.lowercase(Locale.US).replaceFirstChar { it.titlecase(Locale.US) }
        },
        tone = tone,
        meta = event.podName?.let(::mono),
        trailing = InsightsDates.parse(event.createdAt)?.relativeDescription(now),
        footer = event.message?.let { androidx.compose.ui.text.AnnotatedString(it) },
        titleMaxLines = 1,
    )
}
