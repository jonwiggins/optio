package dev.optio.core.data

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.File
import java.nio.file.Files
import java.time.Instant
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest

/** Port of iOS `ServerRegistryTests` (+ `KeychainTests` for the token store) and DataStore persistence. */
class ServerRegistryTest {
    private val registry = ServerRegistry.inMemory()
    private val dir: File = Files.createTempDirectory("registry").toFile()
    private val scopes = mutableListOf<CoroutineScope>()

    @AfterTest
    fun tearDown() {
        scopes.forEach { it.cancel() }
        dir.deleteRecursively()
    }

    private val a = ServerProfile(name = "Laptop", url = "http://a.test:30400", color = ServerColor.SLATE, addedAt = Instant.parse("2026-09-01T00:00:00Z"))
    private val b = ServerProfile(name = "Studio", url = "http://b.test:30400", color = ServerColor.TEAL, addedAt = Instant.parse("2026-09-02T00:00:00Z"))

    @Test
    fun upsertActivateRemove() =
        runTest {
            registry.upsert(a)
            registry.upsert(b)
            registry.setActiveId(b.id)
            assertEquals(listOf(a.id, b.id), registry.all().map { it.id })
            assertEquals(b.id, registry.active()?.id)

            assertTrue(registry.setToken("optio_pat_a", a.id))
            assertTrue(registry.setToken("optio_pat_b", b.id))
            assertEquals("optio_pat_a", registry.token(a.id))
            // Active first, then by addedAt.
            assertEquals(listOf(b.id, a.id), registry.configured().map { it.id })

            // Rename keeps identity.
            registry.upsert(a.copy(name = "MacBook"))
            assertEquals("MacBook", registry.profile(a.id)?.name)
            assertEquals(2, registry.all().size)

            // Removing the active server falls back to the remaining one and drops its token.
            registry.remove(b.id)
            assertEquals(a.id, registry.active()?.id)
            assertNull(registry.token(b.id))
            assertEquals("optio_pat_a", registry.token(a.id))
        }

    @Test
    fun activeFallsBackToTheFirstAndConfiguredNeedsAToken() =
        runTest {
            assertNull(registry.active())
            registry.upsert(a)
            registry.upsert(b)
            assertEquals(a.id, registry.active()?.id, "no active id: the first profile")
            registry.setActiveId("gone")
            assertEquals(a.id, registry.active()?.id)
            assertEquals(emptyList(), registry.configured(), "no tokens yet")
            registry.setToken("t", b.id)
            assertEquals(listOf(b.id), registry.configured().map { it.id })
            registry.remove(a.id)
            registry.remove(b.id)
            assertNull(registry.active())
            assertEquals(emptyList(), registry.all())
        }

    @Test
    fun activeServerDescribesTheWorkspaceOverride() =
        runTest {
            // iOS testSharedCredentialsDescribeActiveServer
            registry.upsert(a.copy(workspaceId = "ws-1"))
            registry.setActiveId(a.id)
            registry.setToken("optio_pat_a", a.id)
            assertEquals(a.url, registry.active()?.url)
            assertEquals("optio_pat_a", registry.token(registry.active()!!.id))
            assertEquals("ws-1", registry.active()?.workspaceId)
            registry.upsert(registry.active()!!.copy(workspaceId = null))
            assertNull(registry.profile(a.id)?.workspaceId)
        }

    @Test
    fun nextColorSkipsUsed() {
        assertEquals(ServerColor.SLATE, ServerColor.next(emptyList()))
        assertEquals(ServerColor.BLUE, ServerColor.next(listOf(ServerColor.SLATE)))
        assertEquals(ServerColor.GREEN, ServerColor.next(listOf(ServerColor.SLATE, ServerColor.BLUE, ServerColor.TEAL)))
        assertEquals(ServerColor.SLATE, ServerColor.next(ServerColor.entries))
        assertEquals(ServerColor.BLUE, ServerColor.next(ServerColor.entries + ServerColor.SLATE))
    }

    @Test
    fun colorsCarryTheIosHexes() {
        assertEquals(
            listOf(0xFF64748B, 0xFF2F6FED, 0xFF0F9F9A, 0xFF16A34A, 0xFFD97706, 0xFFE11D48, 0xFF4F46E5),
            ServerColor.entries.map { it.argb },
        )
        assertEquals(listOf("slate", "blue", "teal", "green", "amber", "rose", "indigo"), ServerColor.entries.map { it.raw })
        assertEquals(ServerColor.ROSE, ServerColor.fromRaw("rose"))
    }

    @Test
    fun profileNamesAndUrls() {
        assertEquals("laptop", ServerProfile.defaultName("http://laptop.tailnet.ts.net:30400"))
        assertEquals("10.0.2.2", ServerProfile.defaultName("http://10.0.2.2:4971"), "IP literals stay whole")
        assertEquals("server", ServerProfile.defaultName("not a url"))
        assertEquals("laptop", a.copy(name = "  ", url = "https://laptop.tailnet.ts.net").shortName)
        assertEquals("Laptop", a.shortName)
        assertEquals("a.test", a.host)

        assertEquals("https://laptop.tailnet.ts.net", ServerProfile.normalizeUrl("  laptop.tailnet.ts.net "))
        assertEquals("http://10.0.2.2:4971", ServerProfile.normalizeUrl("http://10.0.2.2:4971"))
        assertNull(ServerProfile.normalizeUrl(""))
        assertNull(ServerProfile.normalizeUrl("ftp://files.example"))
        assertNull(ServerProfile.normalizeUrl("http://"))

        assertTrue(ServerProfile.sameUrl("http://h.test:1", "http://H.test:1/"))
        assertFalse(ServerProfile.sameUrl("http://h.test:1", "https://h.test:1"))
    }

    @Test
    fun profilesPersistAcrossStoreInstances() =
        runTest {
            val first = fileRegistry()
            first.upsert(a.copy(workspaceId = "ws-9"))
            first.upsert(b)
            first.setActiveId(b.id)
            first.setToken("optio_pat_b", b.id)
            first.setLastServerUrl("http://b.test:30400")
            closeStores()

            val second = fileRegistry()
            assertEquals(listOf(a.copy(workspaceId = "ws-9"), b), second.all())
            assertEquals(b.id, second.active()?.id)
            assertEquals("optio_pat_b", second.token(b.id))
            assertEquals("http://b.test:30400", second.lastServerUrl())
        }

    @Test
    fun tokensAreEncryptedAtRestAndUndecryptableOnesAreDropped() =
        runTest {
            val store = InMemoryPreferences()
            val tokens = TokenStore(store, XorCipher)
            assertTrue(tokens.set("token.a", "optio_pat_secret"))
            val stored = store.data.first()[stringPreferencesKey("token.a")]!!
            assertFalse(stored.contains("optio_pat_secret"))
            assertEquals("optio_pat_secret", TokenStore(store, XorCipher).get("token.a"), "a fresh store decrypts it")

            store.edit { it[stringPreferencesKey("token.b")] = "not base64!" }
            assertNull(tokens.get("token.b"))
            assertFalse(tokens.accounts().contains("token.b"), "an entry that can't be decrypted is removed")

            // iOS KeychainTests.testRoundTrip
            tokens.set("token.c", "first")
            assertEquals("first", tokens.get("token.c"))
            tokens.set("token.c", "second")
            assertEquals("second", tokens.get("token.c"))
            tokens.delete("token.c")
            assertNull(tokens.get("token.c"))
        }

    @Test
    fun aFailingCipherStoresNothing() =
        runTest {
            val tokens = TokenStore(InMemoryPreferences(), FailingCipher)
            assertFalse(tokens.set("token.a", "x"))
            assertNull(tokens.get("token.a"))
        }

    @Test
    fun aCorruptedProfileListReadsAsEmpty() =
        runTest {
            val store = InMemoryPreferences()
            val corrupted = ServerRegistry(store, TokenStore(InMemoryPreferences(), TokenCipher.Plain))
            store.edit { it[stringPreferencesKey("optio.servers")] = "{not json" }
            assertEquals(emptyList(), corrupted.all())
            store.edit {
                it[stringPreferencesKey("optio.servers")] =
                    """[{"id":"x","name":"X","url":"http://x.test","color":"chartreuse","addedAt":"2026-09-01T00:00:00Z","future":1}]"""
            }
            assertEquals(ServerColor.SLATE, corrupted.all().single().color, "an unknown colour falls back to slate")
        }

    private fun fileRegistry(): ServerRegistry {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO).also(scopes::add)
        val profiles = PreferenceDataStoreFactory.create(scope = scope) { File(dir, "servers.preferences_pb") }
        val tokens = PreferenceDataStoreFactory.create(scope = scope) { File(dir, "tokens.preferences_pb") }
        return ServerRegistry(profiles, TokenStore(tokens, XorCipher))
    }

    private fun closeStores() {
        scopes.forEach { it.cancel() }
        scopes.clear()
    }

    /** A stand-in for the Keystore cipher: reversible, and never the plaintext. */
    private object XorCipher : TokenCipher {
        override fun encrypt(plaintext: ByteArray) = ByteArray(plaintext.size) { (plaintext[it].toInt() xor 0x5A).toByte() }

        override fun decrypt(ciphertext: ByteArray) = encrypt(ciphertext)
    }

    private object FailingCipher : TokenCipher {
        override fun encrypt(plaintext: ByteArray): ByteArray = throw IllegalStateException("keystore unavailable")

        override fun decrypt(ciphertext: ByteArray): ByteArray = throw IllegalStateException("keystore unavailable")
    }

    @Test
    fun devServersSeedStableIdsAndKeepColours() =
        runTest {
            registry.upsert(a)
            registry.setToken("old", a.id)
            val extras =
                mapOf(
                    "OPTIO_DEV_SERVER_URL" to "http://10.0.2.2:4971",
                    "OPTIO_DEV_TOKEN" to "dev",
                    "OPTIO_DEV_SERVER_URL_2" to "http://10.0.2.2:4971",
                    "OPTIO_DEV_TOKEN_2" to "dev2",
                    "OPTIO_DEV_SERVER_NAME_2" to "Second",
                )
            assertTrue(DevServers.hasServers(extras))
            assertTrue(DevServers.seed(registry, extras))
            val seeded = registry.configured()
            assertEquals(listOf("dev-server", "dev-server_2"), seeded.map { it.id })
            assertEquals(listOf("10.0.2.2", "Second"), seeded.map { it.name })
            assertEquals(listOf(ServerColor.SLATE, ServerColor.BLUE), seeded.map { it.color })
            assertEquals("dev-server", registry.activeId())
            assertEquals("dev2", registry.token("dev-server_2"))
            assertNull(registry.token(a.id), "tokens of servers that are gone are dropped")

            // Relaunching with the same extras keeps ids, colours and order.
            registry.upsert(registry.profile("dev-server_2")!!.copy(color = ServerColor.ROSE))
            DevServers.seed(registry, extras)
            assertEquals(listOf(ServerColor.SLATE, ServerColor.ROSE), registry.configured().map { it.color })
            assertNotEquals(emptyList(), registry.all())

            assertFalse(DevServers.seed(registry, mapOf("OPTIO_DEV_SECTION" to "local")))
            assertFalse(DevServers.hasServers(mapOf("OPTIO_DEV_SERVER_URL" to "http://x")))
        }
}
