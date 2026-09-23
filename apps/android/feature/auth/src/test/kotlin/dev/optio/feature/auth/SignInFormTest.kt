package dev.optio.feature.auth

import dev.optio.core.data.ServerColor
import dev.optio.core.data.ServerProfile
import dev.optio.core.data.ServerRegistry
import dev.optio.core.data.SessionStore
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer

/** The sign-in form's logic (iOS `SignInView.normalizedURL`, `canSubmit`, `submit()` and its error mapping). */
class SignInFormTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val server = MockWebServer().apply { start() }
    private val registry = ServerRegistry.inMemory()
    private val session = SessionStore(registry, scope)
    private val url = server.url("/").toString().removeSuffix("/")

    @AfterTest
    fun tearDown() {
        scope.cancel()
        server.close()
    }

    private fun respond(
        body: String,
        code: Int = 200,
    ) = server.enqueue(MockResponse.Builder().code(code).body(body).build())

    private val me = """{"user":{"id":"u1","email":"dev@localhost","workspaceRole":"member"},"authDisabled":false}"""

    @Test
    fun addressNormalisationAndSubmitGate() {
        val form = SignInForm(SignInMode.FIRST)
        assertFalse(form.canSubmit)
        assertEquals("server", form.hostLabel)
        assertEquals("MacBook Pro", form.namePlaceholder)

        form.serverUrl = "  laptop.tailnet.ts.net  "
        assertEquals("https://laptop.tailnet.ts.net", form.normalizedUrl)
        assertEquals("laptop.tailnet.ts.net", form.hostLabel)
        assertEquals("laptop", form.namePlaceholder)
        assertFalse(form.canSubmit, "no token yet")
        form.token = "   "
        assertFalse(form.canSubmit, "a blank token doesn't count")
        form.token = "optio_pat_x"
        assertTrue(form.canSubmit)

        form.serverUrl = "ftp://nope"
        assertNull(form.normalizedUrl)
        assertFalse(form.canSubmit)
    }

    @Test
    fun aBadAddressSaysSoWithoutCallingTheServer() =
        runBlocking<Unit> {
            val form = SignInForm(SignInMode.FIRST).apply { token = "t" }
            assertFalse(form.submit(session))
            assertEquals(SignInError.BadUrl, form.error)
            assertEquals("Enter the server address, including the port if it isn't 443.", form.error?.message)
            assertEquals(0, server.requestCount)
        }

    @Test
    fun serverAnswersMapToTheIosErrors() =
        runBlocking<Unit> {
            val form = SignInForm(SignInMode.FIRST).apply {
                serverUrl = url
                token = "optio_pat_x"
            }
            val host = form.hostLabel

            respond("""{"error":"Invalid or expired session"}""", 401)
            assertFalse(form.submit(session))
            assertEquals(SignInError.Rejected, form.error)
            assertTrue(form.error!!.message.startsWith("The server rejected that token."))

            respond("<html>not found</html>", 404)
            form.submit(session)
            assertEquals(SignInError.NotOptio(host), form.error)

            respond("<html>the web app</html>", 200)
            form.submit(session)
            assertEquals(SignInError.NotOptio(host), form.error, "a body that isn't the API")

            respond("""{"error":"Database unavailable"}""", 503)
            form.submit(session)
            assertEquals(SignInError.Other("Database unavailable"), form.error)
            assertFalse(form.busy)
            assertEquals(SessionStore.Phase.RESTORING, session.phase.value, "nothing was paired")
        }

    @Test
    fun aDeniedLocalNetworkPermissionExplainsItself() =
        runBlocking<Unit> {
            val form = SignInForm(SignInMode.FIRST).apply {
                serverUrl = "http://192.168.1.20:30400"
                token = "optio_pat_x"
            }
            form.localNetworkDenied()
            assertEquals(SignInError.LocalNetworkBlocked("192.168.1.20"), form.error)
            assertTrue(form.error!!.message.contains("Nearby devices"))

            // Unreachable while the permission is denied: the same explanation.
            form.serverUrl = "http://127.0.0.1:1"
            assertFalse(form.submit(session, localNetworkBlocked = true))
            assertEquals(SignInError.LocalNetworkBlocked("127.0.0.1"), form.error)
        }

    @Test
    fun anUnreachableServerNamesTheHost() =
        runBlocking<Unit> {
            val form = SignInForm(SignInMode.FIRST).apply {
                serverUrl = "http://127.0.0.1:1"
                token = "optio_pat_x"
            }
            assertFalse(form.submit(session))
            val error = assertIs<SignInError.Unreachable>(form.error)
            assertEquals("127.0.0.1", error.host)
            assertEquals(
                "Couldn't reach 127.0.0.1. Check the address and that this phone is on the same Tailscale network.",
                error.message,
            )
        }

    @Test
    fun firstRunPairsWithoutANameOrColour() =
        runBlocking<Unit> {
            session.restore()
            val form = SignInForm(SignInMode.FIRST).apply {
                serverUrl = url
                token = "  optio_pat_x \n"
                name = "ignored"
                color = ServerColor.ROSE
            }
            respond(me)
            assertTrue(form.submit(session))
            assertNull(form.error)
            assertEquals(SessionStore.Phase.SIGNED_IN, session.phase.value)
            val server = session.activeServer.value!!
            assertEquals(ServerColor.SLATE, server.color)
            assertEquals(ServerProfile.defaultName(url), server.name)
            assertEquals("optio_pat_x", registry.token(server.id), "the token is trimmed")
            assertEquals("Bearer optio_pat_x", this@SignInFormTest.server.takeRequest().headers["Authorization"])
        }

    @Test
    fun addModeUsesTheNameAndColour() =
        runBlocking<Unit> {
            session.restore()
            val form = SignInForm(SignInMode.ADD, initialColor = ServerColor.BLUE).apply {
                serverUrl = url
                token = "optio_pat_x"
                name = " Studio "
            }
            respond(me)
            assertTrue(form.submit(session))
            val server = session.activeServer.value!!
            assertEquals("Studio", server.name)
            assertEquals(ServerColor.BLUE, server.color)
        }
}
