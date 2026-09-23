package dev.optio.feature.widgets

import dev.optio.core.data.ServerClient
import dev.optio.core.data.ServerProfile
import dev.optio.core.glance.GlanceCopy
import dev.optio.core.glance.GlanceLoader
import dev.optio.core.glance.GlancePolicy
import dev.optio.core.glance.GlanceStore
import dev.optio.core.glance.RunTarget
import dev.optio.core.model.arrayValue
import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import dev.optio.feature.widgets.model.boardTiles
import dev.optio.feature.widgets.model.sessionRows
import dev.optio.feature.widgets.run.fire
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * The widgets against a private test API (PLAN §6, §8), preferably the auth-enabled one (the board
 * tiles come from `/api/glance/watch`, which needs a user). Skipped unless `OPTIO_TEST_API_URL` is
 * set; the seed manifest comes from `OPTIO_TEST_SEED`, else the instance's `seed.json`.
 *
 * ```
 * OPTIO_TEST_API_URL=http://127.0.0.1:4991 ./gradlew :feature:widgets:testDebugUnitTest --tests '*LiveWidgetsTest*'
 * ```
 */
class LiveWidgetsTest {
    private val baseUrl: String? = System.getenv("OPTIO_TEST_API_URL")?.trimEnd('/')

    private val seed: JsonObject by lazy {
        val port = checkNotNull(baseUrl).substringAfterLast(':').takeWhile { it.isDigit() }
        val file =
            listOfNotNull(System.getenv("OPTIO_TEST_SEED"), File(System.getProperty("user.home"), ".android/optio-devlab/test-api/$port/seed.json").path)
                .map(::File)
                .firstOrNull { it.isFile } ?: error("no seed.json for $baseUrl (set OPTIO_TEST_SEED)")
        Json.parseToJsonElement(file.readText()) as JsonObject
    }

    private fun seedString(vararg path: String): String? = path.fold(seed as JsonElement?) { el, key -> el?.get(key) }?.stringValue

    private val client: ServerClient by lazy {
        val token = seedString("auth", "adminToken") ?: seedString("api", "token") ?: "dev"
        ServerClient(ServerProfile(id = "live", name = "DevLab", url = baseUrl!!), ApiClient(baseUrl, token))
    }

    @Test
    fun theBoardFromTheLiveApi() =
        runBlocking {
            assumeTrue("set OPTIO_TEST_API_URL to run", baseUrl != null)
            val entry = GlanceLoader(GlanceStore.inMemory(), { listOf(client) }).load(includeTasks = true)
            assertEquals(GlancePolicy.Reachability.LIVE, entry.reachability)
            val rows = entry.sessionRows
            val needsAttention = seedString("tasks", "needsAttention", "id")
            val running = seedString("tasks", "running", "id")
            if (needsAttention != null) assertTrue(rows.first { it.id == needsAttention }.waitsOnYou, "the stuck task waits on you")
            if (running != null) assertTrue(rows.any { it.id == running && !it.waitsOnYou }, "the running task is a running row")
            assertTrue(rows.all { it.link.startsWith("optio://") && it.link.contains("server=live") }, "every row deep-links on its server")
            if (seedString("auth", "adminToken") != null) {
                assertEquals(GlanceCopy.Tile.Id.entries.toList(), entry.boardTiles.map { it.id }, "the auth API sends the three server tiles")
            }
        }

    @Test
    fun listsTargetsAndFiresAJob() =
        runBlocking {
            assumeTrue("set OPTIO_TEST_API_URL to run", baseUrl != null)
            val jobId = checkNotNull(seedString("jobs", "main", "id"))
            val targets = RunTarget.fetchAll(listOf(client))
            val job = targets.first { RunTarget.parse(it.id)?.rawId == jobId }
            assertEquals(RunTarget.makeId("live", RunTarget.Kind.JOB, jobId), job.id)
            seedString("local", "automation", "id")?.let { automation ->
                assertTrue(targets.any { RunTarget.parse(it.id)?.rawId == automation && it.kind == RunTarget.Kind.LOCAL })
            }

            fun runs() = runBlocking { client.api.get<JsonObject>("/api/jobs/$jobId/runs")["runs"]?.arrayValue.orEmpty().mapNotNull { it["id"]?.stringValue } }
            val before = runs()
            client.api.fire(job)
            val after = runs()
            assertEquals(before.size + 1, after.size, "one new run")
        }
}
