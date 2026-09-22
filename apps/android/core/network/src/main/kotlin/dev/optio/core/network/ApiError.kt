package dev.optio.core.network

/**
 * A failed API call (iOS `APIError`).
 *
 * - [status] is the HTTP status for server errors (non-2xx). It is `0` when no usable answer
 *   arrived: the transport failed (unreachable host, timeout, TLS, …; [cause] holds the
 *   `IOException`) or the body did not decode ([isDecodingFailure]).
 * - [message] is the server's `{ "error": … }` (else `{ "message": … }`) for HTTP errors, the
 *   status's standard phrase when the body has neither, an NSURLError-style sentence for transport
 *   failures ("Could not connect to the server."), or `Decoding X failed: …`.
 * - [body] is the raw response body when there was one.
 *
 * `toString()` / [description] read like iOS `errorDescription`: `"<message> (HTTP <status>)"`.
 */
class ApiError(
    val status: Int,
    override val message: String,
    val body: String? = null,
    cause: Throwable? = null,
) : Exception(message, cause) {
    /** The server rejected the credentials (HTTP 401). */
    val isUnauthorized: Boolean
        get() = status == UNAUTHORIZED

    /** The response arrived but could not be decoded into the requested type. */
    val isDecodingFailure: Boolean
        get() = status == 0 && message.startsWith(DECODING_PREFIX)

    /** No answer from the server: network down, host unreachable, timeout, TLS failure. */
    val isTransportFailure: Boolean
        get() = status == 0 && !isDecodingFailure

    /** iOS `errorDescription`: `"<message> (HTTP <status>)"`. */
    val description: String
        get() = "$message (HTTP $status)"

    override fun toString(): String = "ApiError($description)"

    companion object {
        const val UNAUTHORIZED = 401
        const val FORBIDDEN = 403
        const val NOT_FOUND = 404
        const val TOO_MANY_REQUESTS = 429

        internal const val DECODING_PREFIX = "Decoding "
    }
}
