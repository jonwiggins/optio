package dev.optio.core.data

import dev.optio.core.model.FlexibleInstantSerializer
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * One paired Optio instance: a laptop running the local stack, a cluster, a colleague's tailnet
 * box (iOS `ServerProfile`). The phone can hold several and switches between them; each one's
 * token lives in the [TokenStore] under `token.<id>`.
 */
@Serializable
data class ServerProfile(
    val id: String = UUID.randomUUID().toString(),
    /** User-facing label ("MacBook Pro", "Studio", "prod"). Defaults to the host's first label. */
    val name: String,
    /** The address as entered and normalised by sign-in, e.g. `http://laptop.tailnet.ts.net:30400`. */
    val url: String,
    /** Identity colour on every surface that mixes servers. */
    val color: ServerColor = ServerColor.SLATE,
    /** Workspace override sent as `x-workspace-id`; null = the user's default workspace. */
    val workspaceId: String? = null,
    @Serializable(with = FlexibleInstantSerializer::class)
    val addedAt: Instant = Instant.now(),
) {
    /** [url] parsed; null only for a corrupted profile. */
    val httpUrl: HttpUrl?
        get() = url.toHttpUrlOrNull()

    /** The host name, or the whole URL when it does not parse. */
    val host: String
        get() = httpUrl?.host ?: url

    /** Short label for tight spaces (widget headers): the name, or the first host label. */
    val shortName: String
        get() = name.trim().ifEmpty { hostLabel(host) }

    companion object {
        /** The default name for a server at [url]: its host's first label ("laptop" for laptop.tailnet.ts.net). */
        fun defaultName(url: String): String = hostLabel(url.toHttpUrlOrNull()?.host ?: "server")

        /**
         * What the sign-in form accepts (iOS `SignInView.normalizedURL`): trimmed, `https://` when no
         * scheme is given, and it must parse as an http(s) URL. Null when it does not.
         */
        fun normalizeUrl(input: String): String? {
            var raw = input.trim()
            if (raw.isEmpty()) return null
            if (!raw.contains("://")) raw = "https://$raw"
            return raw.takeIf { it.toHttpUrlOrNull() != null }
        }

        /** True when [a] and [b] address the same server (`http://h:1` = `http://h:1/`, host case-insensitive). */
        fun sameUrl(
            a: String,
            b: String,
        ): Boolean {
            val left = a.toHttpUrlOrNull()
            val right = b.toHttpUrlOrNull()
            return if (left != null && right != null) left == right else a.trim() == b.trim()
        }

        /** An IP literal stays whole ("10.0.2.2"); a host name gives its first label. */
        private fun hostLabel(host: String): String =
            if (isIpLiteral(host)) host else host.split('.').firstOrNull()?.takeIf { it.isNotEmpty() } ?: host

        private val ipv4 = Regex("""^\d{1,3}(\.\d{1,3}){3}$""")

        private fun isIpLiteral(host: String): Boolean = ':' in host || ipv4.matches(host)
    }
}
