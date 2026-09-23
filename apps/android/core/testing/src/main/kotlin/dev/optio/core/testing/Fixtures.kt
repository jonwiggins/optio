package dev.optio.core.testing

import dev.optio.core.model.OptioJson
import kotlinx.serialization.json.JsonElement

/**
 * JSON payloads shaped like the API's responses, read from the test classpath: first the calling
 * module's `src/test/resources/fixtures/<name>`, then the shared set `:core:testing` ships under
 * `optio-fixtures/` (see [SHARED]).
 *
 * ```
 * val task = Fixtures.decode<TaskEnvelope>("task.json").task
 * server.fixture("/api/auth/usage", "auth-usage.json")
 * ```
 */
object Fixtures {
    /**
     * The shared fixtures in `:core:testing` (`optio-fixtures/`). Captured from the private test
     * API (auth disabled, no Claude subscription, DevLab seed): `auth-usage-unavailable.json`,
     * `auth-status-unavailable.json`, `auth-me.json` (`{ user, authDisabled: true }`),
     * `local-hosts-devlab.json` (one offline host), `task-logs.json` (`{ logs: [...] }` of a
     * `pr_opened` task), `local-transcript.json` (a recorded 14-entry Claude Code transcript).
     * Constructed in the same shapes, dated around [Samples.NOW]: `auth-usage.json` (live 5h 31%,
     * 7d 52%, 7d Fable 88%), `auth-usage-stale.json`, `auth-usage-expired.json` (both tokens
     * failing), `auth-status.json`, `auth-status-expired.json`, `local-hosts.json` (two hosts with
     * Codex snapshots, the fresher one online).
     */
    val SHARED: List<String> = listOf(
        "auth-usage.json",
        "auth-usage-stale.json",
        "auth-usage-expired.json",
        "auth-usage-unavailable.json",
        "auth-status.json",
        "auth-status-expired.json",
        "auth-status-unavailable.json",
        "auth-me.json",
        "local-hosts.json",
        "local-hosts-devlab.json",
        "task-logs.json",
        "local-transcript.json",
    )

    /** The fixture's text; throws when neither location has it. */
    fun text(name: String): String {
        val loader = Thread.currentThread().contextClassLoader ?: Fixtures::class.java.classLoader
        val url = loader.getResource("fixtures/$name") ?: loader.getResource("optio-fixtures/$name")
        return checkNotNull(url) { "Missing fixture $name (looked in fixtures/ and optio-fixtures/)" }.readText()
    }

    /** The fixture parsed as JSON. */
    fun json(name: String): JsonElement = OptioJson.parseToJsonElement(text(name))

    /** The fixture decoded as [T] with `OptioJson` (the app's decoder). */
    inline fun <reified T> decode(name: String): T = OptioJson.decodeFromString(text(name))
}
