package dev.optio.core.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * Persistence for the paired servers (iOS `ServerRegistry` + `SharedCredentials`): profiles and
 * the active id in one DataStore, each token in [tokens] under `token.<id>`. Pure storage:
 * [SessionStore] owns the live session and calls in here. Widgets, tiles and workers share the
 * app process, so they read the same instance (through `SessionStore.client(serverId)` /
 * `SessionStore.clients()`), where iOS needed an App Group.
 */
class ServerRegistry(
    private val store: DataStore<Preferences>,
    /** Where the tokens live. */
    val tokens: TokenStore,
) {
    private val removalListeners = CopyOnWriteArrayList<ServerRemovalListener>()

    /** Every profile, in the order added; emits on every change. */
    val profiles: Flow<List<ServerProfile>> = store.data.map { decode(it[SERVERS]) }.distinctUntilChanged()

    /** The active profile's id, as stored; emits on every change. */
    val activeIdChanges: Flow<String?> = store.data.map { it[ACTIVE_ID] }.distinctUntilChanged()

    /** Every profile, in the order added. */
    suspend fun all(): List<ServerProfile> = profiles.first()

    /** Replaces every profile (tokens are untouched). */
    suspend fun setAll(profiles: List<ServerProfile>) {
        store.edit { it[SERVERS] = encode(profiles) }
    }

    suspend fun activeId(): String? = activeIdChanges.first()

    suspend fun setActiveId(id: String?) {
        store.edit { if (id == null) it.remove(ACTIVE_ID) else it[ACTIVE_ID] = id }
    }

    /** The active profile: the stored active id, else the first profile. */
    suspend fun active(): ServerProfile? {
        val prefs = store.data.first()
        val servers = decode(prefs[SERVERS])
        return servers.firstOrNull { it.id == prefs[ACTIVE_ID] } ?: servers.firstOrNull()
    }

    suspend fun profile(id: String): ServerProfile? = all().firstOrNull { it.id == id }

    /** Servers with a usable token, active first, then in the order they were added. */
    suspend fun configured(): List<ServerProfile> {
        val activeId = active()?.id
        return all()
            .filter { token(it.id) != null }
            .sortedWith(compareBy<ServerProfile> { it.id != activeId }.thenBy { it.addedAt })
    }

    /** Adds [profile], or replaces the profile with its id. */
    suspend fun upsert(profile: ServerProfile) {
        store.edit { prefs ->
            val servers = decode(prefs[SERVERS]).toMutableList()
            val index = servers.indexOfFirst { it.id == profile.id }
            if (index >= 0) servers[index] = profile else servers.add(profile)
            prefs[SERVERS] = encode(servers)
        }
    }

    /**
     * Forgets a profile and its token; removing the active one makes the first remaining active.
     * [ServerRemovalListener]s hear about it first, while the token still exists.
     */
    suspend fun remove(id: String) {
        profile(id)?.let { profile ->
            val token = token(id)
            // A failing listener never keeps a server around.
            removalListeners.forEach { listener -> runCatching { listener.beforeRemove(profile, token) } }
        }
        tokens.delete(tokenAccount(id))
        store.edit { prefs ->
            val servers = decode(prefs[SERVERS]).filter { it.id != id }
            prefs[SERVERS] = encode(servers)
            if (prefs[ACTIVE_ID] == id) {
                val next = servers.firstOrNull()?.id
                if (next == null) prefs.remove(ACTIVE_ID) else prefs[ACTIVE_ID] = next
            }
        }
    }

    /** The token for server [id]. */
    suspend fun token(id: String): String? = tokens.get(tokenAccount(id))

    /** Calls [listener] before every later [remove]; close the handle to stop. */
    fun addRemovalListener(listener: ServerRemovalListener): AutoCloseable {
        removalListeners += listener
        return AutoCloseable { removalListeners -= listener }
    }

    /** Stores the token for server [id]; false when it could not be encrypted. */
    suspend fun setToken(
        token: String,
        id: String,
    ): Boolean = tokens.set(tokenAccount(id), token)

    /** The last address the first-run sign-in paired (prefills the form; iOS `optio.lastServerURL`). */
    suspend fun lastServerUrl(): String? = store.data.first()[LAST_SERVER_URL]

    suspend fun setLastServerUrl(url: String) {
        store.edit { it[LAST_SERVER_URL] = url }
    }

    companion object {
        private val SERVERS = stringPreferencesKey("optio.servers")
        private val ACTIVE_ID = stringPreferencesKey("optio.activeServerId")
        private val LAST_SERVER_URL = stringPreferencesKey("optio.lastServerURL")

        private val json =
            Json {
                ignoreUnknownKeys = true
                encodeDefaults = true
                explicitNulls = false
                coerceInputValues = true
            }
        private val listSerializer = ListSerializer(ServerProfile.serializer())

        /** The token account of server [id]. */
        fun tokenAccount(id: String): String = "token.$id"

        private fun encode(profiles: List<ServerProfile>): String = json.encodeToString(listSerializer, profiles)

        private fun decode(raw: String?): List<ServerProfile> =
            raw?.let { runCatching { json.decodeFromString(listSerializer, it) }.getOrNull() }.orEmpty()

        /** A registry held in memory with unencrypted tokens: for tests and previews only. */
        fun inMemory(): ServerRegistry = ServerRegistry(InMemoryPreferences(), TokenStore(InMemoryPreferences(), TokenCipher.Plain))
    }
}

/**
 * Told about a server just before [ServerRegistry.remove] deletes its profile and [token] (null
 * when none is stored): the last moment anything can still reach that server as this user, e.g. to
 * unregister this device's push token from it. Removal runs under the session's lock, so don't
 * block: copy what you need and do network work in your own scope.
 */
fun interface ServerRemovalListener {
    fun beforeRemove(
        profile: ServerProfile,
        token: String?,
    )
}
