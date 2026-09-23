package dev.optio.core.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Port of iOS `DeepLinkServerTests` plus every form of the scheme, legacy ones included. */
class DeepLinkTest {
    private val every: Map<DeepLink, String> =
        linkedMapOf(
            DeepLink.Task("t1") to "optio://tasks/t1",
            DeepLink.Local("lt1") to "optio://local/lt1",
            DeepLink.Local("lt1", compose = true) to "optio://local/lt1?compose=1",
            DeepLink.Agent("a1") to "optio://agents/a1",
            DeepLink.Agent("a1", compose = true) to "optio://agents/a1?compose=1",
            DeepLink.Session("s1") to "optio://sessions/s1",
            DeepLink.NewWork to "optio://work/new",
            DeepLink.NeedsYou to "optio://needs-you",
            DeepLink.Work("recurring") to "optio://section/work?view=recurring",
            DeepLink.Section("machines") to "optio://section/machines",
            DeepLink.Section("more") to "optio://section/more",
            DeepLink.Settings to "optio://settings",
        )

    @Test
    fun everyFormHasItsUrlAndParsesBack() {
        every.forEach { (link, url) ->
            assertEquals(url, link.url, "url of $link")
            assertEquals(link, DeepLink.parse(url), "parse $url")
        }
    }

    @Test
    fun everyFormRoundTripsWithAServerHint() {
        every.keys.forEach { link ->
            val url = link.url(server = "srv-1")
            assertEquals(link, DeepLink.parse(url), "parse $url")
            assertEquals("srv-1", DeepLink.serverId(url), "server of $url")
        }
        assertEquals("optio://local/lt1?compose=1&server=dev-server_2", DeepLink.Local("lt1", true).url("dev-server_2"))
        assertEquals("optio://needs-you?server=s", DeepLink.NeedsYou.url("s"))
    }

    @Test
    fun serverHintRoundTrips() {
        // iOS DeepLinkServerTests.testServerHintRoundTrips
        val url = DeepLink.Local("t1", compose = true).url(server = "srv-1")
        assertEquals("srv-1", DeepLink.serverId(url))
        assertEquals(DeepLink.Local("t1", compose = true), DeepLink.parse(url))
        assertNull(DeepLink.serverId(DeepLink.Task("x").url))
        assertEquals("s", DeepLink.serverId(DeepLink.NeedsYou.url(server = "s")))
        assertEquals(DeepLink.NeedsYou, DeepLink.parse(DeepLink.NeedsYou.url(server = "s")))
    }

    @Test
    fun legacyForms() {
        assertEquals(DeepLink.NewWork, DeepLink.parse("optio://sessions/new"))
        assertEquals(DeepLink.Work("agents"), DeepLink.parse("optio://section/sessions?view=agents"))
        assertEquals(DeepLink.Section("sessions"), DeepLink.parse("optio://section/sessions"))
        assertEquals(DeepLink.Section("work"), DeepLink.parse("optio://section/work"), "no view: a plain section")
        assertEquals(DeepLink.Section("tasks"), DeepLink.parse("optio://section/tasks?view=recurring"))
        assertEquals("recurring", DeepLink.queryValue("optio://section/tasks?view=recurring", "view"))
        assertEquals(DeepLink.NeedsYou, DeepLink.parse("optio://needs-you/anything"))
        assertEquals(DeepLink.Settings, DeepLink.parse("optio://settings/"))
    }

    @Test
    fun composeIsOnlyTheLiteralOne() {
        assertEquals(DeepLink.Local("x", compose = false), DeepLink.parse("optio://local/x?compose=true"))
        assertEquals(DeepLink.Agent("x", compose = false), DeepLink.parse("optio://agents/x?compose"))
        assertEquals(DeepLink.Agent("x", compose = true), DeepLink.parse("optio://agents/x?server=s&compose=1"))
    }

    @Test
    fun onlyTheExtraPathSegmentIsIgnored() {
        assertEquals(DeepLink.Task("t1"), DeepLink.parse("optio://tasks/t1/logs"))
        assertEquals(DeepLink.Task("t1"), DeepLink.parse("OPTIO://tasks/t1"), "the scheme is case-insensitive")
    }

    @Test
    fun rejectsWhatItDoesNotKnow() {
        listOf(
            "https://tasks/t1",
            "optio://tasks",
            "optio://tasks/",
            "optio://local",
            "optio://agents",
            "optio://work",
            "optio://work/abc",
            "optio://section",
            "optio://unknown/x",
            "not a url",
            "",
        ).forEach { assertNull(DeepLink.parse(it), it) }
        assertNull(DeepLink.serverId("not a url at all %%"))
    }

    @Test
    fun idsAndValuesAreEncoded() {
        val odd = DeepLink.Task("a b&c")
        assertEquals("optio://tasks/a%20b&c", odd.url)
        assertEquals(odd, DeepLink.parse(odd.url))
        val server = DeepLink.Work("all").url(server = "id&with=odd+chars")
        assertEquals("optio://section/work?view=all&server=id%26with%3Dodd%2Bchars", server)
        assertEquals("id&with=odd+chars", DeepLink.serverId(server))
    }
}
