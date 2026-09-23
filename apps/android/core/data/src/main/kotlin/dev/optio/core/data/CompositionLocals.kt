package dev.optio.core.data

import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * The process-wide [SessionStore], provided by the app root (above the auth gate, so the sign-in
 * screen has it too). Tests and previews provide one built on `ServerRegistry.inMemory()`:
 *
 * ```
 * val session = SessionStore(ServerRegistry.inMemory(), backgroundScope)
 * CompositionLocalProvider(LocalSessionStore provides session) { ServersScreen() }
 * ```
 */
val LocalSessionStore: ProvidableCompositionLocal<SessionStore> =
    staticCompositionLocalOf { error("No SessionStore: the app root provides LocalSessionStore") }
