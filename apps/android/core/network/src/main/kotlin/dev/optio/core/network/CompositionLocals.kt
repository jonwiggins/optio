package dev.optio.core.network

import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * The active server's [ApiClient] (`SessionStore.api`), provided by the signed-in root around the
 * shell. The default is an unconfigured client whose calls fail with [ApiError], so previews and
 * screenshot tests render without setup (they show the error state).
 */
val LocalApiClient: ProvidableCompositionLocal<ApiClient> = staticCompositionLocalOf { ApiClient() }

/**
 * The app's [EventHub] (`SessionStore.events`), provided by the signed-in root. The default is an
 * idle hub that never emits.
 */
val LocalEventHub: ProvidableCompositionLocal<EventHub> = staticCompositionLocalOf { EventHub(ApiClient()) }

/**
 * The signed-in [CurrentUser] (`SessionStore.user`), or null while it is unknown (just switched,
 * server unreachable) and in previews. Gate mutating UI on `LocalCurrentUser.current?.canMutate`
 * and admin UI on `isAdmin`; the server still enforces roles, so also handle a 403.
 */
val LocalCurrentUser: ProvidableCompositionLocal<CurrentUser?> = compositionLocalOf { null }
