package dev.optio.core.ui.scope

import dev.optio.core.network.CurrentUser
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

class ScopeTest {
    private data class Row(val id: String, val ownerUserId: String?, val ownerName: String? = null)

    private val me = ScopeViewer(id = "u-me", isAdmin = false)
    private val admin = ScopeViewer(id = "u-admin", isAdmin = true)

    @Test
    fun ownerScopeFollowsTheRule() {
        assertEquals(OwnerScope.ORGANIZATION, ownerScope(null, "u-me"))
        assertEquals(OwnerScope.ORGANIZATION, ownerScope("", "u-me"))
        assertEquals(OwnerScope.PRIVATE, ownerScope("u-me", "u-me"))
        assertEquals(OwnerScope.OTHERS, ownerScope("u-other", "u-me"))
        // Unknown viewer (auth disabled: one person): everything private is theirs.
        assertEquals(OwnerScope.PRIVATE, ownerScope("u-other", null))
    }

    @Test
    fun viewerFromTheCurrentUser() {
        assertEquals(ScopeViewer.UNKNOWN, (null as CurrentUser?).scopeViewer())
        val member = CurrentUser(id = "u-1", role = CurrentUser.ROLE_MEMBER).scopeViewer()
        assertEquals(ScopeViewer("u-1", isAdmin = false), member)
        assertEquals(OwnerChoice.PRIVATE, member.defaultChoice)
        val admin = CurrentUser(id = "u-2", role = CurrentUser.ROLE_ADMIN).scopeViewer()
        assertTrue(admin.isAdmin)
        assertEquals(OwnerChoice.ORGANIZATION, admin.defaultChoice)
        val local = CurrentUser(id = "local", authDisabled = true).scopeViewer()
        assertNull(local.id, "an auth-disabled server has one person; nothing is someone else's")
        assertTrue(local.isAdmin)
    }

    @Test
    fun tagsAndReadOnly() {
        assertNull(me.privateTag(null, null))
        assertEquals("Private", me.privateTag("u-me", null))
        assertEquals("Private · Ann", admin.privateTag("u-me", "Ann"))
        assertEquals("Private · someone", admin.privateTag("u-me", null))
        assertTrue(admin.isOthers("u-me"))
        assertFalse(me.isOthers("u-me"))
        assertFalse(me.isOthers(null))
    }

    @Test
    fun sectionsAreOrganizationPrivateThenOthersWhenAny() {
        val rows = listOf(Row("a", null), Row("b", "u-me"), Row("c", "u-other", "Ann"), Row("d", null))
        val mine = scopeSections(rows, me) { it.ownerUserId }
        assertEquals(listOf(OwnerScope.ORGANIZATION, OwnerScope.PRIVATE, OwnerScope.OTHERS), mine.map { it.scope })
        assertEquals(listOf("a", "d"), mine[0].rows.map { it.id }, "order within a section is kept")
        assertEquals(listOf("b"), mine[1].rows.map { it.id })
        assertEquals(listOf("c"), mine[2].rows.map { it.id })

        val orgOnly = scopeSections(listOf(Row("a", null)), me) { it.ownerUserId }
        assertEquals(listOf(OwnerScope.ORGANIZATION, OwnerScope.PRIVATE), orgOnly.map { it.scope }, "Private shows even when empty; Other people's only when any")
        assertTrue(orgOnly[1].rows.isEmpty())
    }

    @Test
    fun copy() {
        assertEquals("Private secrets are yours alone: only you see them and only your work can use them.", privateHint("secrets"))
        assertEquals("Only an admin can make this secret the organization's.", organizationNeedsAdmin("secret"))
        assertTrue(othersReadOnly("Ann").startsWith("Ann's private"))
        assertTrue(othersReadOnly(null).startsWith("Its owner's private"))
    }
}
