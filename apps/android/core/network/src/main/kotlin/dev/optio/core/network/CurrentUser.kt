package dev.optio.core.network

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * The signed-in user as returned by `GET /api/auth/me` (iOS `CurrentUser`). Hand-written: the
 * route's `user` is untyped in the TS schema.
 *
 * [role] is the role in the current workspace (`workspaceRole` on the wire): admin / member /
 * viewer. [authDisabled] comes from the response envelope (`{ user, authDisabled }`): a dev server
 * with `OPTIO_AUTH_DISABLED=true` allows everything, so [isAdmin] and [canMutate] are true there
 * (as iOS `MoreContext` resolves it); otherwise they follow the role the server enforces.
 */
@Serializable
data class CurrentUser(
    val id: String,
    val provider: String? = null,
    val email: String? = null,
    val displayName: String? = null,
    /** Provider handle (GitHub login / GitLab username); null when unknown. */
    val username: String? = null,
    val avatarUrl: String? = null,
    val workspaceId: String? = null,
    @SerialName("workspaceRole") val role: String? = null,
    val authDisabled: Boolean = false,
) {
    /** May administer the workspace (repos, secrets, connections, settings…). */
    val isAdmin: Boolean
        get() = authDisabled || role == ROLE_ADMIN

    /** May change anything at all (members and admins); viewers are read-only. */
    val canMutate: Boolean
        get() = authDisabled || role == ROLE_ADMIN || role == ROLE_MEMBER

    /** Best label for the account: display name, else email, else id. */
    val label: String
        get() = displayName?.takeIf { it.isNotBlank() } ?: email?.takeIf { it.isNotBlank() } ?: id

    companion object {
        const val ROLE_ADMIN = "admin"
        const val ROLE_MEMBER = "member"
        const val ROLE_VIEWER = "viewer"
    }
}
