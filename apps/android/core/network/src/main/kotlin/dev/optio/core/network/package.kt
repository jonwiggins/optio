/**
 * `:core:network` (pure Kotlin/JVM): `ApiClient` (OkHttp 5), `WebSocketClient`, `EventHub` and
 * the auth endpoints. Owned by Agent C (PLAN §3, §5). Feature modules add typed endpoints as
 * extension functions on `ApiClient` inside their own module.
 */
package dev.optio.core.network
