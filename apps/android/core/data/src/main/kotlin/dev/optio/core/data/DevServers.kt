package dev.optio.core.data

import java.time.Instant

/**
 * DEBUG-only launch extras that pair servers without the sign-in form (PLAN §6; iOS
 * `SIMCTL_CHILD_OPTIO_DEV_*`). The app reads them only when `BuildConfig.DEBUG`:
 *
 * ```
 * adb shell am start -n dev.optio.android/dev.optio.app.MainActivity \
 *   --es OPTIO_DEV_SERVER_URL http://10.0.2.2:4971 --es OPTIO_DEV_TOKEN dev \
 *   [--es OPTIO_DEV_SERVER_URL_2 … --es OPTIO_DEV_TOKEN_2 … --es OPTIO_DEV_SERVER_NAME_2 …] \
 *   [--es OPTIO_DEV_SECTION local] [--es OPTIO_DEV_OPEN_URL 'optio://…']
 * ```
 */
object DevServers {
    const val SERVER_URL = "OPTIO_DEV_SERVER_URL"
    const val TOKEN = "OPTIO_DEV_TOKEN"
    const val SERVER_NAME = "OPTIO_DEV_SERVER_NAME"

    /** Opens a section by its deep-link name (`local`, `machines`, `recurring` views via legacy names…). */
    const val SECTION = "OPTIO_DEV_SECTION"

    /** An `optio://` link delivered ~2 s after launch (e.g. `optio://section/tasks?server=dev-server_2`). */
    const val OPEN_URL = "OPTIO_DEV_OPEN_URL"

    /** Server id prefix; the n-th server is `dev-server_n` (the first has no suffix). */
    const val ID = "dev-server"

    /** `""`, `"_2"` … `"_9"`. */
    val suffixes: List<String> = listOf("") + (2..9).map { "_$it" }

    /** Every extra this app understands (to pick them out of an intent). */
    val keys: List<String> = suffixes.flatMap { listOf(SERVER_URL + it, TOKEN + it, SERVER_NAME + it) } + listOf(SECTION, OPEN_URL)

    /** True when [extras] pair at least one server. */
    fun hasServers(extras: Map<String, String>): Boolean = suffixes.any { extras[SERVER_URL + it] != null && extras[TOKEN + it] != null }

    /**
     * Replaces the registry with the servers in [extras] (stable ids, so `?server=dev-server_2`
     * links work from the CLI), keeps each one's colour across launches, makes the first active
     * and drops tokens of servers that are gone. False when [extras] name no server.
     */
    internal suspend fun seed(
        registry: ServerRegistry,
        extras: Map<String, String>,
    ): Boolean {
        val existing = registry.all()
        val now = Instant.now()
        val profiles = mutableListOf<ServerProfile>()
        suffixes.forEachIndexed { index, suffix ->
            val token = extras[TOKEN + suffix]?.takeIf { it.isNotBlank() } ?: return@forEachIndexed
            val url = extras[SERVER_URL + suffix]?.let(ServerProfile::normalizeUrl) ?: return@forEachIndexed
            val id = ID + suffix
            val previous = existing.firstOrNull { it.id == id }
            val name = extras[SERVER_NAME + suffix]?.trim()?.takeIf { it.isNotEmpty() } ?: ServerProfile.defaultName(url)
            val color =
                previous?.color
                    ?: existing.firstOrNull { ServerProfile.sameUrl(it.url, url) && it.color !in profiles.map(ServerProfile::color) }?.color
                    ?: ServerColor.next(profiles.map { it.color })
            if (!registry.setToken(token, id)) return@forEachIndexed
            profiles += ServerProfile(id = id, name = name, url = url, color = color, addedAt = previous?.addedAt ?: now.plusMillis(index.toLong()))
        }
        if (profiles.isEmpty()) return false
        registry.setAll(profiles)
        registry.setActiveId(profiles.first().id)
        val keep = profiles.map { ServerRegistry.tokenAccount(it.id) }.toSet()
        registry.tokens.accounts().filter { it.startsWith("token.") && it !in keep }.forEach { registry.tokens.delete(it) }
        return true
    }
}
