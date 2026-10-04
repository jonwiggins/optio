package dev.optio.core.ui.scope

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Business
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import dev.optio.core.network.CurrentUser
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.medium

// Organization and private scope, as the UI shows it (web `lib/owner.ts`, `owner-chip.tsx`,
// `scoped-list.tsx`, `owner-picker.tsx`; `docs/plans/org-scoping-and-sso.md`). Every scoped
// resource — secrets, connections, model providers, MCP servers, skills, prompts, work — carries
// `ownerUserId`: null = the **organization's** (everyone in the workspace sees it); set = someone's
// **private** one (visible to them alone, and read-only to a workspace admin, who sees it under
// **Other people's**, named with its owner).
//
// One vocabulary everywhere: pickers say Organization / Private, lists are sectioned
// Organization / Private / Other people's, a compact tag says Private (or Private · Name).

/** Which section a row falls in for the viewer. */
enum class OwnerScope(val label: String) {
    ORGANIZATION("Organization"),
    PRIVATE("Private"),
    OTHERS("Other people's"),
}

/** The owner a create / edit form picks: the organization's, or the signed-in person's. */
enum class OwnerChoice(val label: String) {
    ORGANIZATION("Organization"),
    PRIVATE("Private"),
}

/**
 * Who is looking: the signed-in user's [id] and whether they administer the workspace. [id] is
 * null while the user is unknown and on an auth-disabled dev server (one person: everything
 * private is theirs), so a private row is never mistaken for someone else's.
 */
data class ScopeViewer(
    val id: String?,
    val isAdmin: Boolean,
) {
    fun scopeOf(ownerUserId: String?): OwnerScope = ownerScope(ownerUserId, id)

    /** Someone else's private row: read-only (an admin may still delete it, for offboarding). */
    fun isOthers(ownerUserId: String?): Boolean = scopeOf(ownerUserId) == OwnerScope.OTHERS

    /**
     * The compact tag for a row: "Private" for the viewer's own, "Private · Name" for someone
     * else's; null for the organization's (the norm carries no tag).
     */
    fun privateTag(
        ownerUserId: String?,
        ownerName: String?,
    ): String? = when (scopeOf(ownerUserId)) {
        OwnerScope.ORGANIZATION -> null
        OwnerScope.PRIVATE -> OwnerScope.PRIVATE.label
        OwnerScope.OTHERS -> "${OwnerScope.PRIVATE.label} · ${ownerName ?: "someone"}"
    }

    /** What a new row opens on: Organization for admins (who may make one), Private for everyone else. */
    val defaultChoice: OwnerChoice
        get() = if (isAdmin) OwnerChoice.ORGANIZATION else OwnerChoice.PRIVATE

    companion object {
        /** Nobody known yet (previews, right after a server switch). */
        val UNKNOWN = ScopeViewer(id = null, isAdmin = false)
    }
}

/** Which scope a row with [ownerUserId] falls in for [viewerId] (`ownerScope` in the web's `lib/owner.ts`). */
fun ownerScope(
    ownerUserId: String?,
    viewerId: String?,
): OwnerScope = when {
    ownerUserId.isNullOrEmpty() -> OwnerScope.ORGANIZATION
    viewerId == null || ownerUserId == viewerId -> OwnerScope.PRIVATE
    else -> OwnerScope.OTHERS
}

/** The viewer behind a `/api/auth/me` answer (null = unknown). */
fun CurrentUser?.scopeViewer(): ScopeViewer = when {
    this == null -> ScopeViewer.UNKNOWN
    authDisabled -> ScopeViewer(id = null, isAdmin = true)
    else -> ScopeViewer(id = id, isAdmin = isAdmin)
}

/** The viewer from `LocalCurrentUser`, for screens. */
object Scope {
    val viewer: ScopeViewer
        @Composable @ReadOnlyComposable get() = LocalCurrentUser.current.scopeViewer()
}

/** One section of a scoped list. */
data class ScopeSection<T>(
    val scope: OwnerScope,
    val rows: List<T>,
)

/**
 * [rows] grouped into the sections every scoped list shows: **Organization** and **Private**
 * always (an empty Private section says what private means for the resource), **Other people's**
 * only when there are any — only an admin receives them. Rows keep their order within a section.
 */
fun <T> scopeSections(
    rows: List<T>,
    viewer: ScopeViewer,
    ownerOf: (T) -> String?,
): List<ScopeSection<T>> {
    val by = rows.groupBy { viewer.scopeOf(ownerOf(it)) }
    return buildList {
        add(ScopeSection(OwnerScope.ORGANIZATION, by[OwnerScope.ORGANIZATION].orEmpty()))
        add(ScopeSection(OwnerScope.PRIVATE, by[OwnerScope.PRIVATE].orEmpty()))
        by[OwnerScope.OTHERS]?.takeIf { it.isNotEmpty() }?.let { add(ScopeSection(OwnerScope.OTHERS, it)) }
    }
}

/** The one line an empty Private section shows: what private means for [what] (plural: "secrets"). */
fun privateHint(what: String): String = "Private $what are yours alone: only you see them and only your work can use them."

/** Why Organization is disabled for a non-admin ([what] singular: "secret"). */
fun organizationNeedsAdmin(what: String): String = "Only an admin can make this $what the organization's."

/** Why someone else's private row is read-only. */
fun othersReadOnly(ownerName: String?): String =
    "${ownerName ?: "Its owner"}'s private — it runs with their credentials; only they can change or use it."

/**
 * The compact scope tag (web `OwnerChip`): a lock and **Private** on an accent tint for the
 * viewer's own row, **Private · Name** on a quiet fill for someone else's. Nothing for the
 * organization's. Shown where rows of different scopes mix without sections: the Work list,
 * pickers, detail headers. Test tag `private-tag`.
 */
@Composable
fun PrivateTag(
    ownerUserId: String?,
    ownerName: String?,
    modifier: Modifier = Modifier,
    viewer: ScopeViewer = Scope.viewer,
) {
    val label = viewer.privateTag(ownerUserId, ownerName) ?: return
    val others = viewer.isOthers(ownerUserId)
    val colors = OptioTheme.colors
    val fill = if (others) colors.fillTertiary else colors.accent.copy(alpha = 0.12f)
    val tint = if (others) colors.secondaryLabel else colors.accent
    Row(
        modifier
            .background(fill, Radius.smallShape)
            .padding(horizontal = 6.dp, vertical = 2.dp)
            .testTag("private-tag"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Icon(Icons.Outlined.Lock, contentDescription = null, tint = tint, modifier = Modifier.size(10.dp))
        Text(label, style = OptioTheme.type.caption2.medium(), color = tint, maxLines = 1)
    }
}

/**
 * The Owner row every create / edit form shows (web `OwnerPicker`): **Organization** or
 * **Private** as radio rows, one helper sentence per resource, and Organization disabled with
 * the reason when the organization's needs an admin the viewer isn't ([canOrganization]).
 * Test tags `owner-organization`, `owner-private`.
 *
 * @param what the resource, singular, for the helper sentences ("secret", "connection").
 */
@Composable
fun OwnerPicker(
    value: OwnerChoice,
    onChange: (OwnerChoice) -> Unit,
    what: String,
    modifier: Modifier = Modifier,
    canOrganization: Boolean = true,
    organizationHint: String = "Everyone in the workspace sees and can use this $what.",
    privateHint: String = "Only you see this $what, and only your work can use it. Admins see that it exists.",
    header: String? = "Owner",
) {
    val colors = OptioTheme.colors
    Column(modifier.fillMaxWidth()) {
        if (header != null) {
            Text(
                header,
                style = OptioTheme.type.sectionHeader,
                color = colors.secondaryLabel,
                modifier = Modifier.padding(start = Spacing.l + Spacing.l, top = Spacing.s),
            )
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.l)) {
            OwnerPickerRow(
                choice = OwnerChoice.ORGANIZATION,
                icon = Icons.Outlined.Business,
                selected = value == OwnerChoice.ORGANIZATION,
                disabledReason = if (canOrganization) null else organizationNeedsAdmin(what),
                onClick = { onChange(OwnerChoice.ORGANIZATION) },
            )
            OwnerPickerRow(
                choice = OwnerChoice.PRIVATE,
                icon = Icons.Outlined.Lock,
                selected = value == OwnerChoice.PRIVATE,
                disabledReason = null,
                onClick = { onChange(OwnerChoice.PRIVATE) },
            )
        }
        Text(
            if (value == OwnerChoice.PRIVATE) privateHint else organizationHint,
            style = OptioTheme.type.footnote,
            color = colors.secondaryLabel,
            modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.xs),
        )
    }
}

@Composable
private fun OwnerPickerRow(
    choice: OwnerChoice,
    icon: ImageVector,
    selected: Boolean,
    disabledReason: String?,
    onClick: () -> Unit,
) {
    val colors = OptioTheme.colors
    val enabled = disabledReason == null
    val tint = if (enabled) colors.label else colors.tertiaryLabel
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .testTag("owner-${choice.name.lowercase()}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        Icon(icon, contentDescription = null, tint = if (enabled) colors.secondaryLabel else colors.tertiaryLabel, modifier = Modifier.padding(start = Spacing.s).size(18.dp))
        Column(Modifier.padding(start = Spacing.s)) {
            Text(choice.label, style = OptioTheme.type.body, color = tint)
            if (disabledReason != null) {
                Text(disabledReason, style = OptioTheme.type.caption, color = colors.tertiaryLabel)
            }
        }
    }
}
