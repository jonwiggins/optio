package dev.optio.core.network

import dev.optio.core.model.OptioJson
import dev.optio.core.model.RawEnum
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.reflect.typeOf
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.serializer
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Thin HTTP client for the Optio API (port of iOS `APIClient`, itself a mirror of
 * `apps/web/src/lib/api-client.ts`): a bearer PAT (`optio_pat_*`) plus an optional
 * `x-workspace-id` override, JSON in and out through [OptioJson], 30 s timeouts.
 *
 * ```
 * val task = api.get<OptioTask>("/api/tasks/$id")
 * val page = api.get<TasksPage>("/api/tasks", query = mapOf("state" to "running", "limit" to 50))
 * val run = api.post<WorkflowRun>("/api/jobs/$id/runs", body = RunBody(params))
 * api.post("/api/tasks/$id/retry")                          // fire-and-forget: body ignored
 * api.patch<Repo>("/api/repos/$id", body = buildJsonObject { put("reviewModel", JsonNull) })
 * ```
 *
 * - `body` is `Any?`: a `@Serializable` value, a `JsonElement`, a `Map` / `List`, or a primitive
 *   (see [JsonBodies]). Only `null` means "no body".
 * - `query` values may be strings, numbers, booleans or generated enums; `null` values are
 *   dropped and `Iterable` values repeat the key.
 * - Non-2xx responses throw [ApiError] (message from `{error}` / `{message}`); a 401 also calls
 *   [onUnauthorized] first. Transport failures and undecodable bodies throw [ApiError] with status 0.
 * - `T = Unit` ignores the response body.
 *
 * Feature modules add typed endpoints as extension functions on `ApiClient` in their own module
 * (mirrors iOS `extension APIClient` per feature); route-local envelopes (`{ tasks, total }`) are
 * declared beside them.
 *
 * Thread-safe: requests run on OkHttp's dispatcher and resume the caller's coroutine; the
 * configuration fields are volatile and read once per request.
 */
class ApiClient(
    /** The OkHttp client requests go through (shared: [OptioHttp.client]). */
    val httpClient: OkHttpClient = OptioHttp.client,
) {
    /** A client already pointed at [baseUrl] with [token]. */
    constructor(
        baseUrl: String?,
        token: String?,
        workspaceId: String? = null,
        httpClient: OkHttpClient = OptioHttp.client,
    ) : this(httpClient) {
        configure(baseUrl, token, workspaceId)
    }

    /** The server's base URL; null until [configure]d (or when the configured string was invalid). */
    @Volatile
    var baseUrl: HttpUrl? = null
        private set

    /** The personal access token sent as `Authorization: Bearer …`. */
    @Volatile
    var token: String? = null
        private set

    /** Workspace override sent as `x-workspace-id`; null = the user's default workspace. */
    @Volatile
    var workspaceId: String? = null

    /** Called (on the requesting coroutine) whenever a response is 401, before [ApiError] is thrown. */
    @Volatile
    var onUnauthorized: (() -> Unit)? = null

    /** The one kotlinx [Json] for Optio's wire format. */
    val json: Json
        get() = OptioJson

    /** [httpClient] tuned for WebSockets (no read timeout, pings); shares its connection pool. */
    val webSocketHttpClient: OkHttpClient by lazy {
        if (httpClient === OptioHttp.client) OptioHttp.webSocketClient else OptioHttp.webSocketClient(httpClient)
    }

    /** Points the client at a server. An unparseable [baseUrl] leaves it unconfigured. */
    fun configure(
        baseUrl: String?,
        token: String?,
        workspaceId: String?,
    ) {
        this.baseUrl = baseUrl?.trim()?.toHttpUrlOrNull()
        this.token = token
        this.workspaceId = workspaceId
    }

    /** True once both a base URL and a token are set. */
    val isConfigured: Boolean
        get() = baseUrl != null && token != null

    // region URL building

    /**
     * [path] (e.g. `/api/tasks/abc`) resolved against [baseUrl] (keeping any base path prefix),
     * with [query] appended. A `?…` suffix on [path] is kept as a pre-encoded query.
     *
     * @throws ApiError (status 0) when no server is configured.
     */
    fun url(
        path: String,
        query: Map<String, Any?> = emptyMap(),
    ): HttpUrl {
        val base = baseUrl ?: throw ApiError(0, NOT_CONFIGURED)
        val builder = base.newBuilder()
        val pathPart = path.substringBefore('?')
        val queryPart = if ('?' in path) path.substringAfter('?') else null
        val segments = pathPart.trimStart('/')
        if (segments.isNotEmpty()) builder.addPathSegments(segments)
        if (!queryPart.isNullOrEmpty()) builder.encodedQuery(queryPart)
        query.forEach { (name, value) ->
            when (value) {
                null -> Unit
                is Iterable<*> -> value.filterNotNull().forEach { builder.addQueryParameter(name, queryValue(it)) }
                else -> builder.addQueryParameter(name, queryValue(value))
            }
        }
        return builder.build()
    }

    /** The `ws(s)://` form of [path], for [WebSocketClient]. */
    fun wsUrl(path: String): String {
        val http = url(path).toString()
        return if (http.startsWith("https:")) "wss:" + http.removePrefix("https:") else "ws:" + http.removePrefix("http:")
    }

    // endregion

    // region Typed requests

    /** `GET path?query` decoded as [T]. */
    suspend inline fun <reified T> get(
        path: String,
        query: Map<String, Any?> = emptyMap(),
    ): T = request("GET", path, query, body = null)

    /** `POST path` with an optional JSON [body], decoded as [T] (`Unit` ignores the response). */
    suspend inline fun <reified T> post(
        path: String,
        body: Any? = null,
        query: Map<String, Any?> = emptyMap(),
    ): T = request("POST", path, query, body)

    /** `PATCH path` with a JSON [body], decoded as [T]. */
    suspend inline fun <reified T> patch(
        path: String,
        body: Any?,
        query: Map<String, Any?> = emptyMap(),
    ): T = request("PATCH", path, query, body)

    /** `PUT path` with a JSON [body], decoded as [T]. */
    suspend inline fun <reified T> put(
        path: String,
        body: Any?,
        query: Map<String, Any?> = emptyMap(),
    ): T = request("PUT", path, query, body)

    /** `DELETE path`, decoded as [T]. */
    suspend inline fun <reified T> delete(
        path: String,
        query: Map<String, Any?> = emptyMap(),
        body: Any? = null,
    ): T = request("DELETE", path, query, body)

    /** Any method, decoded as [T] (`Unit` ignores the body; a nullable [T] turns an empty body into null). */
    suspend inline fun <reified T> request(
        method: String,
        path: String,
        query: Map<String, Any?> = emptyMap(),
        body: Any? = null,
    ): T {
        val bytes = raw(method, path, query, body)
        if (typeOf<T>().classifier == Unit::class) return Unit as T
        return decode(bytes, json.serializersModule.serializer<T>())
    }

    // endregion

    // region Fire-and-forget (iOS `post(_:body:)` / `delete(_:)`: the response body is ignored)

    /** `POST path` ignoring the response body. Still throws [ApiError] on failure. */
    @JvmName("postIgnoringResult")
    suspend fun post(
        path: String,
        body: Any? = null,
        query: Map<String, Any?> = emptyMap(),
    ) {
        raw("POST", path, query, body)
    }

    /** `DELETE path` ignoring the response body. Still throws [ApiError] on failure. */
    @JvmName("deleteIgnoringResult")
    suspend fun delete(
        path: String,
        query: Map<String, Any?> = emptyMap(),
        body: Any? = null,
    ) {
        raw("DELETE", path, query, body)
    }

    // endregion

    // region Raw

    /**
     * Performs the request and returns the 2xx response body.
     *
     * @throws ApiError non-2xx (after calling [onUnauthorized] on a 401), transport failure, or no
     *   server configured.
     */
    suspend fun raw(
        method: String,
        path: String,
        query: Map<String, Any?> = emptyMap(),
        body: Any? = null,
    ): ByteArray {
        val request = buildRequest(method, url(path, query), body)
        val result =
            try {
                httpClient.newCall(request).awaitResult()
            } catch (e: IOException) {
                throw ApiError(0, transportMessage(e), cause = e)
            }
        if (result.code !in 200..299) {
            if (result.code == ApiError.UNAUTHORIZED) onUnauthorized?.invoke()
            val text = result.body.decodeToString()
            throw ApiError(result.code, errorMessage(text) ?: statusPhrase(result.code), body = text)
        }
        return result.body
    }

    private fun buildRequest(
        method: String,
        url: HttpUrl,
        body: Any?,
    ): Request {
        val requestBody: RequestBody? =
            when {
                body != null -> JsonBodies.encode(body).toRequestBody(JSON_MEDIA_TYPE)
                method in METHODS_WITH_BODY -> EMPTY_BODY
                else -> null
            }
        return Request.Builder()
            .url(url)
            .method(method, requestBody)
            .apply {
                token?.let { header("Authorization", "Bearer $it") }
                workspaceId?.let { header("x-workspace-id", it) }
                header("Accept", "application/json")
            }.build()
    }

    /** Decodes a response body; failures become [ApiError] with status 0 (iOS parity). */
    @PublishedApi
    internal fun <T> decode(
        bytes: ByteArray,
        deserializer: DeserializationStrategy<T>,
    ): T {
        val text = bytes.decodeToString()
        @Suppress("UNCHECKED_CAST")
        if (text.isBlank() && deserializer.descriptor.isNullable) return null as T
        return try {
            OptioJson.decodeFromString(deserializer, text)
        } catch (e: SerializationException) {
            throw decodingError(deserializer, e, text)
        } catch (e: IllegalArgumentException) {
            throw decodingError(deserializer, e, text)
        }
    }

    private fun decodingError(
        deserializer: DeserializationStrategy<*>,
        cause: Exception,
        text: String,
    ): ApiError {
        val name = deserializer.descriptor.serialName.substringAfterLast('.').removeSuffix("?")
        return ApiError(0, "${ApiError.DECODING_PREFIX}$name failed: ${cause.message}", body = text, cause = cause)
    }

    // endregion

    // region Auth endpoints

    /** `GET /api/auth/me`: the signed-in user (with the envelope's `authDisabled`). */
    suspend fun currentUser(): CurrentUser {
        val me = get<MeResponse>("/api/auth/me")
        return me.user.copy(authDisabled = me.authDisabled)
    }

    /** Single-use, short-lived (~30 s) token for WebSocket upgrades (`GET /api/auth/ws-token`). */
    suspend fun wsToken(): String = get<WsTokenResponse>("/api/auth/ws-token").token

    // endregion

    /** A [WebSocketClient] for [path] on this server, authenticated like iOS's convenience init. */
    fun webSocket(
        path: String,
        autoReconnect: Boolean = true,
    ): WebSocketClient = WebSocketClient(this, path, autoReconnect)

    companion object {
        internal const val NOT_CONFIGURED = "No Optio server is configured."
        private val JSON_MEDIA_TYPE = "application/json".toMediaType()
        private val EMPTY_BODY: RequestBody = ByteArray(0).toRequestBody(null)
        private val METHODS_WITH_BODY = setOf("POST", "PUT", "PATCH")

        private fun queryValue(value: Any): String =
            when (value) {
                is RawEnum -> value.raw
                is Enum<*> -> value.name
                else -> value.toString()
            }

        /** `{ "error": "…" }`, else `{ "message": "…" }` (iOS `errorMessage(from:)`). */
        internal fun errorMessage(text: String): String? {
            val obj = runCatching { Json.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return null
            fun field(key: String) = (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
            return field("error") ?: field("message")
        }

        /** iOS `HTTPURLResponse.localizedString(forStatusCode:)`. */
        internal fun statusPhrase(code: Int): String =
            STATUS_PHRASES[code] ?: when (code) {
                in 100..199 -> "informational"
                in 200..299 -> "success"
                in 300..399 -> "redirected"
                in 400..499 -> "client error"
                else -> "server error"
            }

        private val STATUS_PHRASES =
            mapOf(
                400 to "bad request",
                401 to "unauthorized",
                402 to "payment required",
                403 to "forbidden",
                404 to "not found",
                405 to "method not allowed",
                406 to "unacceptable",
                407 to "proxy authentication required",
                408 to "request timed out",
                409 to "conflict",
                410 to "no longer exists",
                411 to "length required",
                412 to "precondition failed",
                413 to "request too large",
                414 to "requested URL too long",
                415 to "unsupported media type",
                422 to "unprocessable entity",
                429 to "too many requests",
                500 to "internal server error",
                501 to "unimplemented",
                502 to "bad gateway",
                503 to "service unavailable",
                504 to "gateway timed out",
                505 to "unsupported version",
            )

        /** NSURLError-style sentences, so iOS error copy ports unchanged. */
        internal fun transportMessage(e: IOException): String =
            when (e) {
                is UnknownHostException -> "A server with the specified hostname could not be found."
                is ConnectException, is NoRouteToHostException -> "Could not connect to the server."
                is SocketTimeoutException -> "The request timed out."
                is InterruptedIOException ->
                    if (e.message == "timeout") "The request timed out." else e.message ?: "The request was cancelled."
                is SSLException -> "An SSL error has occurred and a secure connection to the server cannot be made."
                else -> e.message?.takeIf { it.isNotBlank() } ?: "The network connection was lost."
            }
    }
}

/** `GET /api/auth/me` → `{ user, authDisabled }`. */
@kotlinx.serialization.Serializable
internal data class MeResponse(
    val user: CurrentUser,
    val authDisabled: Boolean = false,
)

/** `GET /api/auth/ws-token` → `{ token }`. */
@kotlinx.serialization.Serializable
internal data class WsTokenResponse(val token: String)

/** A response read to the end on OkHttp's thread (never on the caller's, which may be Main). */
internal class HttpResult(
    val code: Int,
    val body: ByteArray,
)

/** Enqueues the call, cancelling it with the coroutine. */
internal suspend fun Call.awaitResult(): HttpResult =
    suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { cancel() }
        enqueue(
            object : Callback {
                override fun onFailure(
                    call: Call,
                    e: IOException,
                ) {
                    if (continuation.isActive) continuation.resumeWithException(e)
                }

                override fun onResponse(
                    call: Call,
                    response: Response,
                ) {
                    val result =
                        try {
                            response.use { HttpResult(it.code, it.body.bytes()) }
                        } catch (e: IOException) {
                            if (continuation.isActive) continuation.resumeWithException(e)
                            return
                        }
                    if (continuation.isActive) continuation.resume(result)
                }
            },
        )
    }
