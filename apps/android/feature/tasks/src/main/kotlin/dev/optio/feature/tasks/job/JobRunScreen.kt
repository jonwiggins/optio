package dev.optio.feature.tasks.job

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Replay
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.model.AgentLogEntry
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.CodeBlock
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.DetailHeader
import dev.optio.core.ui.components.DetailTabs
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.StateDot
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.Cost
import dev.optio.core.ui.format.InsightsFormat
import dev.optio.core.ui.format.LocalClock
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.log.AgentLogView
import dev.optio.core.ui.state.ErrorText
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.tasks.common.CollectUiMessages
import dev.optio.feature.tasks.common.DetailScaffold
import dev.optio.feature.tasks.data.JobRun
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonElement

/** The run detail's segments. */
enum class RunSection(val label: String) { LOGS("Logs"), DETAILS("Details") }

/** `JobRunRoute(jobId, runId)`: one Job run (iOS `JobRunDetailView`, web `/jobs/[id]/runs/[runId]`). */
@Composable
fun JobRunScreen(jobId: String, runId: String) {
    val api = LocalApiClient.current
    val vm: JobRunViewModel = viewModel { JobRunViewModel(api, jobId, runId) }
    JobRunScreen(vm)
}

@Composable
internal fun JobRunScreen(vm: JobRunViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    val jobName by vm.jobName.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val entries by vm.logs.entries.collectAsStateWithLifecycle()
    val connected by vm.logs.connected.collectAsStateWithLifecycle()
    val loaded by vm.logs.loaded.collectAsStateWithLifecycle()
    val logError by vm.logs.error.collectAsStateWithLifecycle()
    val active = state.value?.isActive == true

    LaunchedEffect(vm) { if (vm.state.value.value == null) vm.load() else vm.refresh() }
    // iOS `.task(id: isActive)`: poll every 5 s while the run is active.
    LaunchedEffect(vm, active) {
        if (!active) return@LaunchedEffect
        while (true) {
            delay(5.seconds)
            vm.refresh()
        }
    }
    DisposableEffect(vm) {
        vm.logs.start()
        onDispose { vm.logs.stop() }
    }
    CollectUiMessages(vm.messages)

    JobRunContent(
        runId = vm.runId,
        state = state,
        jobName = jobName,
        busy = busy,
        logEntries = entries,
        logConnected = connected,
        logLoaded = loaded,
        logError = logError,
        onRetryLoad = vm::load,
        onRefresh = vm::load,
        onRetry = vm::retry,
        onCancel = vm::cancel,
    )
}

@Composable
fun JobRunContent(
    runId: String,
    state: LoadState<JobRun>,
    jobName: String?,
    busy: Boolean,
    logEntries: List<AgentLogEntry>,
    logConnected: Boolean,
    logLoaded: Boolean,
    logError: Throwable?,
    modifier: Modifier = Modifier,
    initialSection: RunSection = RunSection.LOGS,
    onRetryLoad: () -> Unit = {},
    onRefresh: () -> Unit = {},
    onRetry: () -> Unit = {},
    onCancel: () -> Unit = {},
) {
    val run = state.value
    val canMutate = Roles.canMutate
    val confirm = rememberConfirmState()
    var section by rememberSaveable { mutableStateOf(initialSection) }
    DetailScaffold(
        title = run?.title?.takeIf { it.isNotBlank() } ?: jobName ?: "Run ${runId.take(8)}",
        modifier = modifier.testTag("job-run"),
        actions = {
            if (run != null && canMutate) {
                if (run.canRetry) {
                    IconButton(onClick = onRetry, enabled = !busy, modifier = Modifier.testTag("run-retry")) {
                        Icon(Icons.Outlined.Replay, contentDescription = "Retry")
                    }
                }
                if (run.canCancel) {
                    IconButton(
                        onClick = { confirm.ask("Cancel this run?", null, "Cancel Run", destructive = true, onConfirm = onCancel) },
                        enabled = !busy,
                        modifier = Modifier.testTag("run-cancel"),
                    ) {
                        Icon(Icons.Outlined.StopCircle, contentDescription = "Cancel", tint = OptioTheme.colors.red)
                    }
                }
            }
            if (busy) {
                Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                }
            } else {
                IconButton(onClick = onRefresh, modifier = Modifier.testTag("run-refresh")) {
                    Icon(Icons.Outlined.Refresh, contentDescription = "Refresh")
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).readableWidth()) {
            when {
                run != null -> {
                    RunHeader(run, runId, logConnected)
                    DetailTabs(options = RunSection.entries.map { it to it.label }, selection = section, onSelect = { section = it })
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        when (section) {
                            RunSection.LOGS -> RunLogs(run, logEntries, logLoaded, logError)
                            RunSection.DETAILS -> RunDetails(run)
                        }
                    }
                }
                state is LoadState.Failed -> ErrorRow(state.error, what = "run", retry = onRetryLoad)
                else -> SkeletonRows()
            }
        }
    }
    ConfirmHost(confirm)
}

/** The header line (iOS `header(_:)`), for tests. */
internal object RunHeaderText {
    fun line(run: JobRun, runId: String, now: Instant): AnnotatedString? = metaText(
        run.durationText(now) ?: run.createdAt?.relativeDescription(now),
        run.modelUsed?.let(InsightsFormat::modelShortName),
        Cost.formatIfNonZero(run.costUsd),
        run.tokensText,
        run.retryCount?.takeIf { it > 0 }?.let { "retry $it" },
        mono(runId.take(8)),
    )
}

@Composable
private fun RunHeader(run: JobRun, runId: String, connected: Boolean) {
    val now = rememberNow()
    DetailHeader(
        state = run.state,
        line = RunHeaderText.line(run, runId, now),
        secondary = run.errorMessage?.takeIf { it.isNotEmpty() }?.let(::AnnotatedString),
    ) {
        if (connected) StateDot(Tone.WORKING, size = 6.dp, modifier = Modifier.testTag("live-dot"))
    }
}

@Composable
private fun RunLogs(run: JobRun, entries: List<AgentLogEntry>, loaded: Boolean, error: Throwable?) {
    if (entries.isEmpty()) {
        Column(
            Modifier.fillMaxSize().padding(Spacing.xl).testTag("logs-empty"),
            verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (run.isActive || !loaded) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
            Text(
                if (run.isActive || !loaded) "Waiting for output…" else "No logs recorded",
                style = OptioTheme.type.footnote,
                color = OptioTheme.colors.secondaryLabel,
            )
            if (error != null) Text(ErrorText.humanize(error, "logs"), style = OptioTheme.type.caption, color = OptioTheme.colors.red)
        }
    } else {
        AgentLogView(entries = entries)
    }
}

private val detailDate: DateTimeFormatter = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)

@Composable
private fun RunDetails(run: JobRun) {
    val clock = LocalClock.current
    val now = rememberNow()
    fun date(i: Instant?): String = i?.let { detailDate.withZone(clock.zone).format(it) } ?: "—"
    LazyColumn(Modifier.fillMaxSize().testTag("run-details"), contentPadding = PaddingValues(bottom = Spacing.xl)) {
        item(key = "run") {
            GroupedSection(header = "Run") {
                val rows = buildList {
                    add(Triple("State", run.state, false))
                    add(Triple("Created", date(run.createdAt), false))
                    add(Triple("Started", date(run.startedAt), false))
                    add(Triple("Finished", date(run.finishedAt), false))
                    add(Triple("Duration", run.durationText(now) ?: "—", false))
                    add(Triple("Model", run.modelUsed ?: "—", false))
                    add(Triple("Cost", run.costUsd?.toDoubleOrNull()?.takeIf { it > 0 }?.let { String.format(java.util.Locale.US, "$%.4f", it) } ?: "—", false))
                    add(Triple("Tokens (in / out)", run.tokensText ?: "—", false))
                    add(Triple("Retries", "${run.retryCount ?: 0}", false))
                    run.podName?.let { add(Triple("Pod", it, true)) }
                    run.sessionId?.let { add(Triple("Session", it, true)) }
                }
                rows.forEachIndexed { index, (label, value, mono) ->
                    if (index > 0) InsetDivider()
                    KeyValueRow(label, value, mono = mono)
                }
            }
        }
        val params = run.params.orEmpty()
        if (params.isNotEmpty()) {
            item(key = "params") {
                GroupedSection(header = "Parameters (${params.size})") {
                    params.keys.sorted().forEachIndexed { index, key ->
                        if (index > 0) InsetDivider()
                        KeyValueRow(key, params.getValue(key).displayValue(), mono = true)
                    }
                }
            }
        }
        prettyJson(run.output)?.let { output ->
            item(key = "output") {
                GroupedSection(header = "Output") {
                    CodeBlock(output, modifier = Modifier.padding(Spacing.m), background = OptioTheme.colors.fillQuaternary)
                }
            }
        }
        run.errorMessage?.takeIf { it.isNotEmpty() }?.let { error ->
            item(key = "error") {
                GroupedSection(header = "Error") {
                    CodeBlock(error, color = OptioTheme.colors.red, modifier = Modifier.padding(Spacing.m), background = OptioTheme.colors.fillQuaternary)
                }
            }
        }
    }
}

/** A param as the details list shows it (iOS `describe`). */
private fun JsonElement.displayValue(): String = displayText()
