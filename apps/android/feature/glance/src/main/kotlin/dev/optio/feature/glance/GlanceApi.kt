package dev.optio.feature.glance

import dev.optio.core.model.PushDevice
import dev.optio.core.model.PushDevicesResponse
import dev.optio.core.model.RegisterAndroidDeviceRequest
import dev.optio.core.model.WatchState
import dev.optio.core.network.ApiClient
import kotlinx.serialization.Serializable

// The endpoints the glanceable surfaces call (iOS: the matching `extension APIClient` methods in
// LocalAPI / TasksAPI / AgentsAPI, PushRegistrar, SnoozeStore, WatchIntents).

/** `POST /api/local/terminals/:id/input`: [data] as typed (a trailing `\r` is Enter). */
suspend fun ApiClient.sendLocalTerminalInput(
    id: String,
    data: String,
) = post("/api/local/terminals/$id/input", body = InputBody(data))

/** `POST /api/persistent-agents/:id/messages`. */
suspend fun ApiClient.sendPersistentAgentMessage(
    id: String,
    body: String,
) = post("/api/persistent-agents/$id/messages", body = AgentMessageBody(body))

/** `POST /api/persistent-agents/:id/control` (`resume`, `pause`, …). */
suspend fun ApiClient.controlPersistentAgent(
    id: String,
    intent: String,
) = post("/api/persistent-agents/$id/control", body = ControlBody(intent))

/** `POST /api/tasks/:id/message`: delivered mid-turn to a running agent, or resumes a stopped task. */
suspend fun ApiClient.sendTaskMessage(
    id: String,
    content: String,
    mode: String = "soft",
) = post("/api/tasks/$id/message", body = TaskMessageBody(content, mode))

/** `GET /api/persistent-agents/:id` (the Watch's agent rows). */
suspend fun ApiClient.getAgentLite(id: String): AgentLite = get<AgentEnvelope>("/api/persistent-agents/$id").agent

/** `GET /api/tasks/:id`, only what unfollowing needs. */
suspend fun ApiClient.getTaskState(id: String): TaskStateLite = get<TaskStateEnvelope>("/api/tasks/$id").task

/** `GET /api/glance/watch`: the caller's Watch frame (Apple-second dates). */
suspend fun ApiClient.glanceWatch(): WatchState = get("/api/glance/watch")

/** `POST /api/notifications/devices` (upsert by token); the server's row. */
suspend fun ApiClient.registerAndroidDevice(body: RegisterAndroidDeviceRequest): PushDevice = post<DeviceEnvelope>("/api/notifications/devices", body = body).device

/** `GET /api/notifications/devices`: every device of the caller plus the providers the server has. */
suspend fun ApiClient.listNotificationDevices(): PushDevicesResponse = get("/api/notifications/devices")

/** `POST /api/notifications/devices/test`: one alert to every device. */
suspend fun ApiClient.sendTestNotification(): Int = post<TestResult>("/api/notifications/devices/test").sent

@Serializable
private data class InputBody(
    val data: String,
)

@Serializable
private data class AgentMessageBody(
    val body: String,
)

@Serializable
private data class ControlBody(
    val intent: String,
)

@Serializable
private data class TaskMessageBody(
    val content: String,
    val mode: String,
)

@Serializable
internal data class DeviceEnvelope(
    val device: PushDevice,
)

@Serializable
internal data class TestResult(
    val sent: Int = 0,
)

/** The part of a persistent agent the Watch shows. */
@Serializable
data class AgentLite(
    val id: String,
    val name: String = "",
    val slug: String = "",
    val state: String = "",
    val agentRuntime: String? = null,
    val lastTurnAt: String? = null,
    val lastFailureReason: String? = null,
)

@Serializable
internal data class AgentEnvelope(
    val agent: AgentLite,
)

/** A task's state and retry budget (unfollow once it is finished everywhere). */
@Serializable
data class TaskStateLite(
    val state: String = "",
    val retryCount: Int? = null,
    val maxRetries: Int? = null,
) {
    /** Completed, cancelled, or failed with no retries left. */
    val isFinished: Boolean
        get() = state == "completed" || state == "cancelled" || (state == "failed" && (retryCount ?: 0) >= (maxRetries ?: 0))
}

@Serializable
internal data class TaskStateEnvelope(
    val task: TaskStateLite,
)
