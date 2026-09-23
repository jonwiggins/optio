package dev.optio.feature.tasks.task

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.network.ApiClient
import dev.optio.core.network.WebSocketClient
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import dev.optio.feature.tasks.common.UiMessage
import dev.optio.feature.tasks.data.StallInfoRow
import dev.optio.feature.tasks.data.TaskActivityItem
import dev.optio.feature.tasks.data.TaskEventRow
import dev.optio.feature.tasks.data.TaskRow
import dev.optio.feature.tasks.data.addTaskComment
import dev.optio.feature.tasks.data.addTaskDependencies
import dev.optio.feature.tasks.data.cancelTask
import dev.optio.feature.tasks.data.createSubtask
import dev.optio.feature.tasks.data.deleteTaskComment
import dev.optio.feature.tasks.data.forceRedoTask
import dev.optio.feature.tasks.data.forceRestartTask
import dev.optio.feature.tasks.data.getTask
import dev.optio.feature.tasks.data.launchReview
import dev.optio.feature.tasks.data.removeTaskDependency
import dev.optio.feature.tasks.data.resumeTask
import dev.optio.feature.tasks.data.retryTask
import dev.optio.feature.tasks.data.runNowTask
import dev.optio.feature.tasks.data.searchTasks
import dev.optio.feature.tasks.data.sendTaskMessage
import dev.optio.feature.tasks.data.subtasks
import dev.optio.feature.tasks.data.taskActivity
import dev.optio.feature.tasks.data.taskDependencies
import dev.optio.feature.tasks.data.taskDependents
import dev.optio.feature.tasks.data.taskEvents
import dev.optio.feature.tasks.logs.TaskLogStream
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

/** Everything the task detail shows (iOS `TaskDetailModel`'s stored properties). */
data class TaskDetail(
    val task: TaskRow,
    val pendingReason: String? = null,
    val stallInfo: StallInfoRow? = null,
    val events: List<TaskEventRow> = emptyList(),
    val subtasks: List<TaskRow> = emptyList(),
    val dependencies: List<TaskRow> = emptyList(),
    val dependents: List<TaskRow> = emptyList(),
    val activity: List<TaskActivityItem> = emptyList(),
) {
    // State predicates mirror apps/web/src/app/tasks/[id]/page.tsx (iOS TaskDetailModel).
    val state: String get() = task.state
    val canCancel: Boolean get() = state in setOf("running", "queued", "provisioning", "needs_attention")
    val canRetry: Boolean get() = state in setOf("failed", "cancelled")
    val canStart: Boolean get() = state == "pending" && task.taskType != "step"
    val canResume: Boolean get() = state in setOf("needs_attention", "failed") && task.sessionId != null

    /** Mid-turn messages reach a running Claude Code agent in a pod (a local run takes input in its terminal). */
    val canMessageRunning: Boolean get() = state == "running" && task.agentType == "claude-code" && !task.isLocal
    val canMessageStopped: Boolean get() = state in setOf("needs_attention", "pr_opened", "failed", "cancelled")
    val canMessage: Boolean get() = canMessageRunning || canMessageStopped
    val canForceRestart: Boolean get() = state in setOf("needs_attention", "failed", "pr_opened")
    val canRequestReview: Boolean get() = state == "pr_opened"
    val canRunNow: Boolean get() = pendingReason?.contains("off-peak") == true && state == "queued"
    val isTerminal: Boolean get() = state in setOf("completed", "failed", "cancelled")
    val isPlanReview: Boolean get() = state == "needs_attention" && events.lastOrNull()?.trigger == "plan_review"
    val isStalled: Boolean get() = stallInfo?.isStalled == true && state == "running"

    /** The composer shows (message a running agent, or resume a stopped one with the message). */
    val showsComposer: Boolean get() = canMessage || canResume

    /** A finished task that can't be resumed: nothing captured its session. */
    val resumeUnavailable: Boolean get() = !showsComposer && isTerminal && task.sessionId == null
}

/** How a message reaches a running agent. */
enum class MessageMode(val raw: String, val label: String) {
    SOFT("soft", "Soft (deliver between turns)"),
    INTERRUPT("interrupt", "Interrupt (stop current work)"),
}

/**
 * The task detail (iOS `TaskDetailModel` + `TaskLogStream`): the task with its events, subtasks,
 * dependencies and activity; the live log; and every action the task's state allows.
 */
class TaskDetailViewModel(
    private val api: ApiClient,
    val taskId: String,
    socketFactory: ((path: String) -> WebSocketClient)? = null,
) : ViewModel() {
    private val _state = MutableStateFlow<LoadState<TaskDetail>>(LoadState.Idle)
    val state: StateFlow<LoadState<TaskDetail>> = _state.asStateFlow()

    private val _busy = MutableStateFlow(false)

    /** An action is running (the menu shows a spinner and is disabled). */
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _messages = Channel<UiMessage>(Channel.BUFFERED)
    val messages: Flow<UiMessage> = _messages.receiveAsFlow()

    /** The log: REST history, then `/ws/logs/:taskId`. Started and stopped by the screen. */
    val logs = TaskLogStream(api, taskId, viewModelScope, socketFactory ?: { api.webSocket(it) })

    private var refreshJob: Job? = null

    init {
        // A state change on the log socket (iOS `onStateChanged`): refetch the task.
        viewModelScope.launch { logs.stateChanges.collect { refresh() } }
    }

    /** The first load, a Retry, or a pull-to-refresh (shows progress over what's on screen). */
    fun load() {
        refreshJob?.cancel()
        refreshJob = viewModelScope.launch { _state.load { fetch() } }
    }

    /** A quiet refetch (polling, after an action): keeps what's on screen, no spinner, no error. */
    fun refresh() {
        if (refreshJob?.isActive == true) return
        if (_state.value.value == null) return load()
        refreshJob = viewModelScope.launch { refreshNow() }
    }

    private suspend fun refreshNow() {
        try {
            _state.value = LoadState.Loaded(fetch())
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Keep the last good state; the next poll tries again.
        }
    }

    /** The task itself is required; events, subtasks, dependencies and activity degrade to empty lists (iOS `load`). */
    private suspend fun fetch(): TaskDetail = coroutineScope {
        val detail = async { api.getTask(taskId) }
        val events = async { runCatching { api.taskEvents(taskId) }.getOrDefault(emptyList()) }
        val subtasks = async { runCatching { api.subtasks(taskId) }.getOrDefault(emptyList()) }
        val dependencies = async { runCatching { api.taskDependencies(taskId) }.getOrDefault(emptyList()) }
        val dependents = async { runCatching { api.taskDependents(taskId) }.getOrDefault(emptyList()) }
        val activity = async { runCatching { api.taskActivity(taskId) }.getOrDefault(emptyList()) }
        val d = detail.await()
        TaskDetail(
            task = d.task,
            pendingReason = d.pendingReason,
            stallInfo = d.stallInfo,
            events = events.await(),
            subtasks = subtasks.await(),
            dependencies = dependencies.await(),
            dependents = dependents.await(),
            activity = activity.await(),
        )
    }

    // region Actions (iOS `run(api:success:_:)`)

    private fun act(success: String? = null, after: () -> Unit = {}, op: suspend ApiClient.() -> Unit) {
        if (_busy.value) return
        viewModelScope.launch { perform(success, after, op) }
    }

    private suspend fun perform(success: String?, after: () -> Unit = {}, op: suspend ApiClient.() -> Unit): Boolean {
        _busy.value = true
        return try {
            api.op()
            success?.let { _messages.trySend(UiMessage.Success(it)) }
            after()
            refreshNow()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _messages.trySend(UiMessage.Failure(e))
            false
        } finally {
            _busy.value = false
        }
    }

    fun cancel() = act { cancelTask(taskId) }

    fun retry() = act { retryTask(taskId) }

    /** "Start" a pending task (the retry route queues it). */
    fun start() = act { retryTask(taskId) }

    /** "Attempt resume": a fresh session on the existing PR branch. */
    fun attemptResume() = act("Task re-queued on existing PR branch") { forceRestartTask(taskId) }

    fun requestReview() = act("Review agent launched") { launchReview(taskId) }

    fun runNow() = act("Task will run immediately") { runNowTask(taskId) }

    /** Clears every log and result and re-runs from scratch; the log reloads. */
    fun forceRedo() = act("Task reset and re-queued", after = { logs.reload() }) { forceRedoTask(taskId) }

    fun approvePlan() = act { resumeTask(taskId, PLAN_APPROVED) }

    /**
     * The composer: messages a running Claude Code agent ([mode]) or a stopped task (which resumes
     * with the message), else resumes it with the message as the prompt. Returns true when sent.
     */
    suspend fun send(text: String, mode: MessageMode): Boolean {
        val detail = _state.value.value ?: return false
        val running = detail.canMessageRunning
        val canMessage = detail.canMessage
        val interrupt = running && mode == MessageMode.INTERRUPT
        return perform(success = null, after = { logs.appendLocal(text, interrupt) }) {
            if (canMessage) sendTaskMessage(taskId, text, if (running) mode.raw else MessageMode.SOFT.raw) else resumeTask(taskId, text)
        }
    }

    suspend fun addComment(text: String): Boolean = perform(success = null) { addTaskComment(taskId, text) }

    fun deleteComment(commentId: String) = act { deleteTaskComment(taskId, commentId) }

    /** Creates a subtask; throws so the sheet can show the error in place. */
    suspend fun createSubtask(title: String, prompt: String, taskType: String, blocksParent: Boolean) {
        api.createSubtask(taskId, title.trim(), prompt.trim(), taskType, blocksParent)
        refreshNow()
    }

    /** Tasks to pick a dependency from: search results minus this task and its current dependencies. */
    suspend fun dependencyCandidates(query: String): List<TaskRow> {
        val exclude = setOf(taskId) + _state.value.value?.dependencies.orEmpty().map { it.id }
        return api.searchTasks(query, limit = 100).filter { it.id !in exclude }
    }

    /** Adds a dependency; throws so the sheet can show the error in place. */
    suspend fun addDependency(dependsOnId: String) {
        api.addTaskDependencies(taskId, listOf(dependsOnId))
        refreshNow()
    }

    fun removeDependency(dependsOnId: String) = act { removeTaskDependency(taskId, dependsOnId) }

    // endregion

    override fun onCleared() {
        logs.stop()
    }

    companion object {
        /** What "Approve plan" sends (iOS / web copy). */
        const val PLAN_APPROVED = "Plan approved. Proceed with implementation following your plan above."
    }
}
