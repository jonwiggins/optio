/**
 * `:core:network` (pure Kotlin/JVM): [ApiClient] (OkHttp 5 + kotlinx.serialization), [ApiError],
 * [WebSocketClient] / [WsFrame], [EventHub], the auth endpoints ([ApiClient.currentUser],
 * [ApiClient.wsToken]) with [CurrentUser], and the CompositionLocals [LocalApiClient],
 * [LocalEventHub] and [LocalCurrentUser]. Owned by Agent C (PLAN §3, §5).
 *
 * Feature modules add typed endpoints as extension functions on `ApiClient` inside their own
 * module (mirrors iOS `extension APIClient` per feature):
 *
 * ```
 * suspend fun ApiClient.retryTask(id: String) = post("/api/tasks/$id/retry")
 * suspend fun ApiClient.task(id: String): OptioTask = get<TaskEnvelope>("/api/tasks/$id").task
 * ```
 *
 * With a typed result always pass the type argument (`post<T>(…)`): without one, the call
 * resolves to the fire-and-forget overload that returns `Unit`.
 */
package dev.optio.core.network
