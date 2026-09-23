package dev.optio.core.data

import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder

/**
 * The `optio://` URL scheme shared by the app, widgets, tiles, notifications and shortcuts (exact
 * port of iOS `Shared/DeepLink.swift`):
 *
 * ```
 * optio://tasks/<id>              optio://local/<id>?compose=1
 * optio://agents/<id>?compose=1   optio://sessions/<id>   (a pod session)
 * optio://work/new                (the New work form; legacy optio://sessions/new)
 * optio://needs-you               (the Work list, Active view — needs-you rows rank first)
 * optio://section/work?view=active|recurring|agents|history|all   ([Work]; legacy section/sessions)
 * optio://section/<name>          (work|reviews|inbox|prompts|repos|machines|connections|analytics|costs|
 *                                  activity|cluster|more; legacy sessions|tasks|jobs|scheduled|agents|local|issues)
 * optio://settings                (the app's settings; the server's test push links here)
 * ```
 *
 * Any link may carry `?server=<ServerProfile.id>` ([url] with a server, [serverId]): the app
 * switches to that server before routing, so a tap on one laptop's item lands there even when
 * another is active.
 */
sealed interface DeepLink {
    data class Task(val id: String) : DeepLink

    data class Local(val id: String, val compose: Boolean = false) : DeepLink

    data class Agent(val id: String, val compose: Boolean = false) : DeepLink

    /** A pod session (`interactive_sessions`). */
    data class Session(val id: String) : DeepLink

    /** The Work list in its Active view (needs-you rows rank first). */
    data object NeedsYou : DeepLink

    /** The New work form (`optio://work/new`); tiles, widgets and shortcuts start work from here. */
    data object NewWork : DeepLink

    /** The Work list in a named view (`optio://section/work?view=…`), raw as in the URL. */
    data class Work(val view: String) : DeepLink

    /** A hub section by its deep-link name, legacy names included (`AppRouter.section(named)`). */
    data class Section(val name: String) : DeepLink

    /** The app's settings (`optio://settings`, what `POST /api/notifications/devices/test` links). */
    data object Settings : DeepLink

    /** This link as a URL, without a server hint. */
    val url: String
        get() = url(server = null)

    /** This link as a URL; [server] adds `?server=<id>`. */
    fun url(server: String?): String {
        val (host, path, items) =
            when (this) {
                is Task -> Triple("tasks", "/$id", emptyList())
                is Local -> Triple("local", "/$id", composeItem(compose))
                is Agent -> Triple("agents", "/$id", composeItem(compose))
                is Session -> Triple("sessions", "/$id", emptyList())
                NewWork -> Triple("work", "/new", emptyList())
                NeedsYou -> Triple("needs-you", "", emptyList())
                is Work -> Triple("section", "/work", listOf("view" to view))
                is Section -> Triple("section", "/$name", emptyList())
                Settings -> Triple("settings", "", emptyList())
            }
        val query = items + listOfNotNull(server?.let { SERVER_QUERY to it })
        return buildString {
            append(SCHEME).append("://").append(host)
            append(path.split('/').joinToString("/") { encode(it, PATH_SAFE) })
            if (query.isNotEmpty()) {
                append('?')
                append(query.joinToString("&") { (key, value) -> encode(key, QUERY_SAFE) + "=" + encode(value, QUERY_SAFE) })
            }
        }
    }

    companion object {
        const val SCHEME = "optio"

        /** Query key carrying a `ServerProfile.id`. */
        const val SERVER_QUERY = "server"

        /** The link [url] names, or null when it is not an `optio://` link this app knows. */
        fun parse(url: String): DeepLink? {
            val uri =
                try {
                    URI(url.trim())
                } catch (_: URISyntaxException) {
                    return null
                }
            if (!SCHEME.equals(uri.scheme, ignoreCase = true)) return null
            val host = uri.host ?: return null
            val id = uri.path.orEmpty().split('/').firstOrNull { it.isNotEmpty() }
            val query = queryItems(uri.rawQuery)
            val compose = query.any { it.first == "compose" && it.second == "1" }
            val view = query.firstOrNull { it.first == "view" }?.second
            return when {
                host == "tasks" && id != null -> Task(id)
                host == "local" && id != null -> Local(id, compose)
                host == "agents" && id != null -> Agent(id, compose)
                (host == "work" || host == "sessions") && id == "new" -> NewWork
                host == "sessions" && id != null -> Session(id)
                host == "needs-you" -> NeedsYou
                host == "section" && (id == "work" || id == "sessions") && view != null -> Work(view)
                host == "section" && id != null -> Section(id)
                host == "settings" -> Settings
                else -> null
            }
        }

        /** The `server=` hint on an `optio://` URL, if any. */
        fun serverId(url: String): String? {
            val uri =
                try {
                    URI(url.trim())
                } catch (_: URISyntaxException) {
                    return null
                }
            return queryItems(uri.rawQuery).firstOrNull { it.first == SERVER_QUERY }?.second
        }

        /** The value of query item [name] on [url] (e.g. an explicit `view=`), if any. */
        fun queryValue(
            url: String,
            name: String,
        ): String? {
            val uri =
                try {
                    URI(url.trim())
                } catch (_: URISyntaxException) {
                    return null
                }
            return queryItems(uri.rawQuery).firstOrNull { it.first == name }?.second
        }

        private fun composeItem(compose: Boolean) = if (compose) listOf("compose" to "1") else emptyList()

        /** `a=1&b` → [("a","1"), ("b", null)], percent-decoded (`+` stays a plus, like URLComponents). */
        private fun queryItems(rawQuery: String?): List<Pair<String, String?>> =
            rawQuery.orEmpty().split('&').filter { it.isNotEmpty() }.map { item ->
                val name = decode(item.substringBefore('='))
                val value = if ('=' in item) decode(item.substringAfter('=')) else null
                name to value
            }

        // The String-charset overload: the Charset one needs API 33.
        private fun decode(text: String): String = runCatching { URLDecoder.decode(text.replace("+", "%2B"), "UTF-8") }.getOrDefault(text)

        // RFC 3986: a path segment may hold sub-delims, ':' and '@'; a query value keeps '&', '='
        // and '+' encoded so it survives key=value splitting.
        private const val UNRESERVED = "-._~"
        private const val PATH_SAFE = "$UNRESERVED!$&'()*+,;=:@"
        private const val QUERY_SAFE = "$UNRESERVED!$'()*,;:@/?"

        private fun encode(
            text: String,
            safe: String,
        ): String =
            buildString {
                text.encodeToByteArray().forEach { byte ->
                    val char = (byte.toInt() and 0xFF).toChar()
                    if (char.isLetterOrDigit() && char.code < 128 || char in safe) {
                        append(char)
                    } else {
                        append('%').append("%02X".format(byte.toInt() and 0xFF))
                    }
                }
            }
    }
}
