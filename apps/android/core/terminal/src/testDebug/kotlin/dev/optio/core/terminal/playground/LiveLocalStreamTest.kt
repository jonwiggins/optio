package dev.optio.core.terminal.playground

import android.os.Looper
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.optio.core.terminal.TerminalGrid
import dev.optio.core.terminal.TerminalSizing
import dev.optio.core.terminal.TerminalState
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

/**
 * End to end against a real Optio Local terminal: a private test API with an online test daemon
 * (`apps/android/scripts/test-api.sh start --port N` + `test-daemon.sh start --port N`), driven
 * through the playground's stream exactly as `:feature:local` will drive the component.
 *
 *   OPTIO_TEST_API_URL=http://127.0.0.1:N ./gradlew :core:terminal:testDebugUnitTest --tests '*LiveLocalStream*'
 *
 * Skipped when OPTIO_TEST_API_URL is unset. Creates one throwaway `{kind:"shell"}` terminal in the
 * daemon's last allowlisted dir and deletes it afterwards.
 */
@RunWith(AndroidJUnit4::class)
class LiveLocalStreamTest {
    private val api: String? = System.getenv("OPTIO_TEST_API_URL")?.trimEnd('/')
    private val http = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build()

    private fun call(method: String, path: String, body: String? = null): JSONObject {
        val request =
            Request.Builder()
                .url("$api$path")
                .header("authorization", "Bearer dev")
                .method(method, body?.toRequestBody("application/json".toMediaType()))
                .build()
        http.newCall(request).execute().use { res ->
            val text = res.body.string()
            check(res.isSuccessful) { "$method $path → ${res.code}: $text" }
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        }
    }

    /** Runs main-looper work (OkHttp callbacks post there) until [done] or the timeout. */
    private fun pumpUntil(timeoutMs: Long = 20_000, what: String, done: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!done()) {
            check(System.currentTimeMillis() < deadline) { "timed out waiting for $what" }
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(25)
        }
    }

    @Test
    fun attachesPassivelyThenClaimsAndTypesIntoARealShell() {
        assumeTrue("set OPTIO_TEST_API_URL to a test API with an online test daemon", api != null)
        val hosts = call("GET", "/api/local/hosts").getJSONArray("hosts")
        val host = (0 until hosts.length()).map { hosts.getJSONObject(it) }.firstOrNull { it.optString("state") == "online" }
        assumeTrue("no online Local host (start test-daemon.sh)", host != null)
        val dirs = host!!.getJSONArray("dirs")
        val dir = dirs.getJSONObject(dirs.length() - 1).getString("path")
        val created =
            call(
                "POST",
                "/api/local/terminals",
                JSONObject()
                    .put("hostId", host.getString("id"))
                    .put("dir", dir)
                    .put("title", "core:terminal LiveLocalStreamTest (throwaway)")
                    .put("spec", JSONObject().put("kind", "shell"))
                    .toString(),
            ).getJSONObject("terminal")
        val id = created.getString("id")
        val terminal = TerminalState()
        var stream: PlaygroundLocalStream? = null
        try {
            pumpUntil(what = "running") { call("GET", "/api/local/terminals/$id").getJSONObject("terminal").getString("state") == "running" }
            // A phone-sized view has laid out.
            terminal.onViewLaidOut(TerminalGrid(50, 20))
            val s = PlaygroundLocalStream(api!!, "dev", id, terminal)
            stream = s
            terminal.onInput = { s.sendInput(it) }
            terminal.onInteraction = { s.onInteraction() }
            terminal.onGridSizeChanged = { s.onGridSizeChanged(it) }
            terminal.onNaturalGridChanged = { s.onNaturalGridChanged() }
            s.connect()
            pumpUntil(what = "the size frame") { s.conn == PlaygroundLocalStream.Conn.Connected && !terminal.isHolding }
            // Attaching never resizes the PTY: we render the daemon's grid, passively.
            val announced = (s.mode as? TerminalSizing.Mode.Passive)?.grid
            assertTrue(announced != null && announced != TerminalGrid(50, 20), "passive on the PTY's own grid, got ${s.mode}")
            assertEquals(announced, terminal.grid)

            // Typing is an explicit interaction: the grid is claimed (resized to ours) first.
            terminal.sendText("echo live-\$((6*7))-ok\r")
            assertEquals(TerminalSizing.Mode.Owner, s.mode)
            assertEquals(TerminalGrid(50, 20), terminal.grid)
            pumpUntil(what = "the command's output") { terminal.transcriptText().contains("live-42-ok") }
            // The daemon echoes our resize; we stay the owner.
            pumpUntil(timeoutMs = 5_000, what = "the resize echo") { s.mode == TerminalSizing.Mode.Owner && s.foreignGrid == null }
        } finally {
            stream?.dispose()
            runCatching { call("POST", "/api/local/terminals/$id/kill", "{}") }
            runCatching {
                pumpUntil(what = "exit") {
                    call("GET", "/api/local/terminals/$id").getJSONObject("terminal").getString("state") in setOf("exited", "error")
                }
            }
            call("DELETE", "/api/local/terminals/$id")
        }
    }
}
