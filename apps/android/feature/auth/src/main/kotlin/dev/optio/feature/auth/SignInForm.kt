package dev.optio.feature.auth

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.optio.core.data.ServerColor
import dev.optio.core.data.ServerProfile
import dev.optio.core.data.SessionStore
import dev.optio.core.network.ApiError
import kotlinx.coroutines.CancellationException
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Why pairing failed, with the iOS copy (`SignInView.SignInError`). */
sealed interface SignInError {
    val message: String

    data object BadUrl : SignInError {
        override val message = "Enter the server address, including the port if it isn't 443."
    }

    data class Unreachable(val host: String) : SignInError {
        override val message =
            "Couldn't reach $host. Check the address and that this phone is on the same Tailscale network."
    }

    data object Rejected : SignInError {
        override val message = "The server rejected that token. Create a new one in the web app under Settings › API keys."
    }

    /**
     * Unreachable while Android 17's local network permission is denied (`LocalNetworkAccess`):
     * the likely cause for a server on this network. Not in iOS (its prompt is automatic).
     */
    data class LocalNetworkBlocked(val host: String) : SignInError {
        override val message =
            "Couldn't reach $host. Optio can't reach devices on your local network without the Nearby devices " +
                "permission: allow it in Settings, then try again."
    }

    /** Something answered, but not an Optio API (wrong port, a web page). Not in iOS, which says "(HTTP 0)". */
    data class NotOptio(val host: String) : SignInError {
        override val message = "$host answered, but not like an Optio server. Check the address and port."
    }

    data class Other(override val message: String) : SignInError
}

/**
 * The sign-in form's state and logic (iOS `SignInView`'s `@State` + `submit()`), kept out of the
 * composable so it can be tested and survives recomposition.
 */
@Stable
class SignInForm(
    val mode: SignInMode,
    initialServerUrl: String = "",
    initialColor: ServerColor = ServerColor.SLATE,
) {
    var serverUrl by mutableStateOf(initialServerUrl)
    var token by mutableStateOf("")
    var name by mutableStateOf("")
    var color by mutableStateOf(initialColor)

    var busy by mutableStateOf(false)
        internal set
    var error by mutableStateOf<SignInError?>(null)
        internal set

    /** The address as it will be paired (`https://` added when no scheme is typed), or null. */
    val normalizedUrl: String?
        get() = ServerProfile.normalizeUrl(serverUrl)

    /** The host for "Connecting to …" and error messages. */
    val hostLabel: String
        get() = normalizedUrl?.toHttpUrlOrNull()?.host ?: "server"

    /** The Name field's placeholder: the default name for the typed address. */
    val namePlaceholder: String
        get() = normalizedUrl?.let(ServerProfile::defaultName) ?: "MacBook Pro"

    val canSubmit: Boolean
        get() = normalizedUrl != null && token.isNotBlank()

    /**
     * The local network permission was denied for a local address: pairing cannot reach it, so say
     * so at once instead of waiting out a connect timeout.
     */
    fun localNetworkDenied() {
        error = SignInError.LocalNetworkBlocked(hostLabel)
    }

    /**
     * Verifies and pairs the server through [session] (`addServer` probes `/api/auth/me` first).
     * True on success: the new server is active and the session signed in. [localNetworkBlocked]
     * (the local network permission is denied) explains an unreachable server.
     */
    suspend fun submit(
        session: SessionStore,
        localNetworkBlocked: Boolean = false,
    ): Boolean {
        val url = normalizedUrl
        if (url == null) {
            error = SignInError.BadUrl
            return false
        }
        if (busy) return false
        busy = true
        error = null
        try {
            session.addServer(
                url = url,
                token = token.trim(),
                name = if (mode == SignInMode.ADD) name else null,
                color = if (mode == SignInMode.ADD) color else null,
            )
            return true
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            error =
                when {
                    e.isUnauthorized -> SignInError.Rejected
                    e.isTransportFailure && localNetworkBlocked -> SignInError.LocalNetworkBlocked(hostLabel)
                    e.isTransportFailure -> SignInError.Unreachable(hostLabel)
                    e.isDecodingFailure || e.status == ApiError.NOT_FOUND -> SignInError.NotOptio(hostLabel)
                    else -> SignInError.Other(e.message)
                }
        } catch (e: Exception) {
            error = SignInError.Other(e.message ?: "Couldn't pair this server.")
        } finally {
            busy = false
        }
        return false
    }
}
