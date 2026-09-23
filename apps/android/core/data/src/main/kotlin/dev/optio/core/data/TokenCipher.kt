package dev.optio.core.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.nio.ByteBuffer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Encrypts tokens before they reach disk. The app uses [KeystoreTokenCipher]; JVM and Robolectric
 * tests (which have no Android Keystore) use [TokenCipher.Plain].
 */
interface TokenCipher {
    fun encrypt(plaintext: ByteArray): ByteArray

    /** Throws when [ciphertext] was not produced by this cipher's key (e.g. the key was lost). */
    fun decrypt(ciphertext: ByteArray): ByteArray

    /** No encryption: for tests and previews only (in-memory registries). */
    object Plain : TokenCipher {
        override fun encrypt(plaintext: ByteArray): ByteArray = plaintext.copyOf()

        override fun decrypt(ciphertext: ByteArray): ByteArray = ciphertext.copyOf()
    }
}

/**
 * AES-256-GCM with a non-exportable key in the Android Keystore (the iOS keychain's role). The key
 * never leaves secure hardware where available and is not included in backups, so tokens do not
 * survive a move to another device (backup is disabled anyway). Output: `[ivLength][iv][ciphertext+tag]`.
 */
class KeystoreTokenCipher(
    private val alias: String = DEFAULT_ALIAS,
) : TokenCipher {
    override fun encrypt(plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        val sealed = cipher.doFinal(plaintext)
        return ByteBuffer.allocate(1 + iv.size + sealed.size).put(iv.size.toByte()).put(iv).put(sealed).array()
    }

    override fun decrypt(ciphertext: ByteArray): ByteArray {
        val buffer = ByteBuffer.wrap(ciphertext)
        val iv = ByteArray(buffer.get().toInt()).also(buffer::get)
        val sealed = ByteArray(buffer.remaining()).also(buffer::get)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
        return cipher.doFinal(sealed)
    }

    @Synchronized
    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(KEY_BITS)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        const val DEFAULT_ALIAS = "dev.optio.tokens"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val KEY_BITS = 256
        private const val TAG_BITS = 128
    }
}
