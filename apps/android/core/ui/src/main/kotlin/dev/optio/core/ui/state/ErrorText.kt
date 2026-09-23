package dev.optio.core.ui.state

import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import dev.optio.core.network.ApiError
import kotlinx.serialization.SerializationException

/**
 * Plain-language error copy (iOS `ErrorText`): decoding failures and rate limits never reach the
 * user raw. [humanize] is what [ErrorRow][dev.optio.core.ui.components.ErrorRow], [Loadable] and
 * the error toasts show.
 */
object ErrorText {
    /**
     * Copy for [error]. [what] names the thing that failed to load ("jobs", "the overview") and
     * shapes the fallback sentences: "Couldn't load jobs — the server hit an error."
     */
    fun humanize(error: Throwable, what: String? = null): String {
        val subject = what?.let { "Couldn't load $it" } ?: "Something went wrong"
        val decoding = "$subject — the server sent something this version of the app doesn't understand."
        if (error is ApiError) {
            return when (error.status) {
                ApiError.TOO_MANY_REQUESTS -> "Slow down — the server is rate limiting. Retrying in a moment."
                ApiError.UNAUTHORIZED -> "Your access token was rejected. Sign in again."
                ApiError.FORBIDDEN -> "You don't have permission for this."
                ApiError.NOT_FOUND -> what?.let { "That ${it.removeSuffix("s")} no longer exists." } ?: "Not found."
                in 500..599 -> "$subject — the server hit an error."
                0 -> {
                    // The client wraps transport failures (cause = the IOException) and bad bodies.
                    (error.cause as? IOException)?.let { return transport(it) }
                    val m = error.message.lowercase()
                    when {
                        error.isDecodingFailure || "decod" in m || "parse" in m -> decoding
                        "offline" in m || "connect" in m || "network" in m -> "Can't reach the server. Check your connection."
                        else -> error.message.ifBlank { subject }
                    }
                }
                else -> error.message.ifBlank { subject }
            }
        }
        return when (error) {
            is SerializationException -> decoding
            is IOException -> transport(error)
            else -> error.message?.takeIf { it.isNotBlank() } ?: subject
        }
    }

    /** iOS maps NSURLError codes; these are the JVM equivalents. */
    private fun transport(error: IOException): String = when (error) {
        is UnknownHostException, is ConnectException, is NoRouteToHostException -> "Can't reach the server."
        is SocketTimeoutException -> "The server took too long to respond."
        is InterruptedIOException -> if (error.message?.contains("timeout", ignoreCase = true) == true) {
            "The server took too long to respond."
        } else {
            "Can't reach the server. Check your connection."
        }
        else -> "Can't reach the server. Check your connection."
    }

    /** True for a 403 (admin-only endpoints: show [AdminOnlyState][dev.optio.core.ui.components.AdminOnlyState]). */
    fun isForbidden(error: Throwable?): Boolean = (error as? ApiError)?.status == ApiError.FORBIDDEN

    /** True for a 401. */
    fun isUnauthorized(error: Throwable?): Boolean = (error as? ApiError)?.isUnauthorized == true
}

/** iOS `Error.isForbidden`. */
val Throwable.isForbidden: Boolean
    get() = ErrorText.isForbidden(this)
