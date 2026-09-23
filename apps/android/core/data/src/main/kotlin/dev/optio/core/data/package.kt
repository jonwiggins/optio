/**
 * `:core:data`: [ServerProfile] + [ServerColor], [ServerRegistry] (DataStore) with [TokenStore]
 * (Android Keystore AES-GCM via [KeystoreTokenCipher]), [SessionStore] (phase, user, servers,
 * active server, generation, the one `ApiClient` + `EventHub`), [DeepLink] (`optio://`),
 * debug-only [DevServers] seeding, and [LocalSessionStore]. `CurrentUser` lives with the auth
 * endpoints in `:core:network`. Owned by Agent C (PLAN §3, §5).
 */
package dev.optio.core.data
