package dev.optio.core.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext

/**
 * Secrets (personal access tokens) by account name, encrypted with [cipher] and kept in their own
 * DataStore file, which is excluded from backup and device transfer (iOS: keychain items, one per
 * account). Decrypted values are cached in memory for the life of the process.
 */
class TokenStore(
    private val store: DataStore<Preferences>,
    private val cipher: TokenCipher,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val cache = ConcurrentHashMap<String, String>()

    /** The secret for [account], or null when there is none (or it can no longer be decrypted). */
    suspend fun get(account: String): String? {
        cache[account]?.let { return it }
        val encoded = store.data.first()[key(account)] ?: return null
        return withContext(io) {
            try {
                cipher.decrypt(Base64.getDecoder().decode(encoded)).decodeToString().also { cache[account] = it }
            } catch (_: Exception) {
                // The key is gone (e.g. device credentials reset): the entry is useless now.
                delete(account)
                null
            }
        }
    }

    /** Stores [value] for [account]. False when it could not be encrypted. */
    suspend fun set(
        account: String,
        value: String,
    ): Boolean {
        val encoded =
            withContext(io) {
                runCatching { Base64.getEncoder().encodeToString(cipher.encrypt(value.encodeToByteArray())) }.getOrNull()
            } ?: return false
        store.edit { it[key(account)] = encoded }
        cache[account] = value
        return true
    }

    /** Forgets [account]'s secret. */
    suspend fun delete(account: String) {
        cache.remove(account)
        store.edit { it.remove(key(account)) }
    }

    /** Every account that has a secret stored. */
    suspend fun accounts(): Set<String> = store.data.first().asMap().keys.map { it.name }.toSet()

    private fun key(account: String) = stringPreferencesKey(account)
}
