package dev.optio.core.ui.auth

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import dev.optio.core.network.LocalCurrentUser

/**
 * Role gating for UI, read from `LocalCurrentUser` (`:core:network`). Hide or disable what the
 * signed-in user may not do; the server still enforces roles, so also handle a 403
 * ([dev.optio.core.ui.state.isForbidden] → [dev.optio.core.ui.components.AdminOnlyState]).
 */
object Roles {
    /**
     * Members and admins may change things; viewers are read-only. True while the user is unknown
     * (previews, right after a server switch) so actions don't flicker in and out.
     */
    val canMutate: Boolean
        @Composable @ReadOnlyComposable get() = LocalCurrentUser.current?.canMutate ?: true

    /** Workspace admins (repos, secrets, connections, settings). False while the user is unknown. */
    val isAdmin: Boolean
        @Composable @ReadOnlyComposable get() = LocalCurrentUser.current?.isAdmin ?: false
}

/** Shows [content] only to users who may mutate ([Roles.canMutate]). */
@Composable
fun IfCanMutate(content: @Composable () -> Unit) {
    if (Roles.canMutate) content()
}

/** Shows [content] only to workspace admins ([Roles.isAdmin]). */
@Composable
fun IfAdmin(content: @Composable () -> Unit) {
    if (Roles.isAdmin) content()
}
