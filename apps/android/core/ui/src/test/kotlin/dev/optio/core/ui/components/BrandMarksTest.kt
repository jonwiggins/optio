package dev.optio.core.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.VectorGroup
import androidx.compose.ui.graphics.vector.VectorPath
import dev.optio.core.model.WorkLink
import dev.optio.core.model.WorkLinkKind
import dev.optio.core.model.WorkLinkProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class BrandMarksTest {
    @Test
    fun providerStringsMapToBrands() {
        assertEquals(Brand.GitHub, Brand.fromProvider("github"))
        assertEquals(Brand.GitLab, Brand.fromProvider("GitLab"))
        assertEquals(Brand.Jira, Brand.fromProvider(" jira "))
        assertEquals(Brand.PagerDuty, Brand.fromProvider("pagerduty"))
        assertEquals(Brand.Pylon, Brand.fromProvider("Pylon"))
        assertNull(Brand.fromProvider("codecommit"))
        assertNull(Brand.fromProvider(null))
    }

    @Test
    fun urlHostsMapToBrands() {
        assertEquals(Brand.GitHub, Brand.fromUrl("https://github.com/acme/app/pull/4"))
        assertEquals(Brand.GitLab, Brand.fromUrl("https://gitlab.example.com/g/p/-/merge_requests/2"))
        assertEquals(Brand.Linear, Brand.fromUrl("https://linear.app/acme/issue/ENG-12"))
        assertEquals(Brand.Jira, Brand.fromUrl("https://acme.atlassian.net/browse/OPS-1"))
        assertEquals(Brand.Notion, Brand.fromUrl("https://www.notion.so/page"))
        assertNull(Brand.fromUrl("https://git-codecommit.us-east-1.amazonaws.com/v1/repos/x"))
        assertNull(Brand.fromUrl("not a url"))
    }

    @Test
    fun triggersShowTheBrandTheyListenTo() {
        assertEquals(Brand.GitHub, triggerBrand("github"))
        assertEquals(Brand.Slack, triggerBrand("slack"))
        assertEquals(Brand.Linear, triggerBrand("linear"))
        assertEquals(Brand.PagerDuty, triggerBrand("pagerduty"))
        assertEquals(Brand.Pylon, triggerBrand("pylon"))
        assertEquals(Brand.GitLab, triggerBrand("gitlab"))
        assertEquals(Brand.Jira, triggerBrand("jira"))
        assertEquals(Brand.Sentry, triggerBrand("sentry"))
        assertEquals(Brand.Alertmanager, triggerBrand("alertmanager"))
        assertEquals(Brand.Datadog, triggerBrand("datadog"))
        assertEquals(Brand.Datadog, Brand.fromProvider("datadog"))
        assertEquals(Brand.Datadog, Brand.fromUrl("https://app.datadoghq.com/monitors/1"))
        assertSame(BrandIcons.Datadog, triggerIcon("datadog"))
        assertSame(BrandIcons.Alertmanager, triggerIcon("alertmanager"))
        assertSame(BrandIcons.PagerDuty, triggerIcon("PagerDuty"))
        assertEquals(Brand.Jira, triggerBrand("ticket", source = "jira"))
        assertNull(triggerBrand("ticket"))
        assertNull(triggerBrand("schedule"))
        assertSame(BrandIcons.Slack, triggerIcon("slack"))
        assertSame(BrandIcons.Linear, triggerIcon("ticket", source = "linear"))
    }

    @Test
    fun prStatesNormalize() {
        assertEquals(PrGlyphState.OPEN, PrGlyphState.from(null))
        assertEquals(PrGlyphState.MERGED, PrGlyphState.from("merged"))
        assertEquals(PrGlyphState.MERGED, PrGlyphState.from("closed", merged = true))
        assertEquals(PrGlyphState.CLOSED, PrGlyphState.from("declined"))
        assertEquals(PrGlyphState.DRAFT, PrGlyphState.from("Draft"))
    }

    @Test
    fun workLinksWearTheirMark() {
        assertSame(BrandIcons.PullRequestOpen, WorkLink("u", WorkLinkKind.PR, WorkLinkProvider.GITHUB, "a/b#1").glyph)
        assertSame(BrandIcons.Linear, WorkLink("u", WorkLinkKind.ISSUE, WorkLinkProvider.LINEAR, "ENG-1").glyph)
        assertSame(BrandIcons.IssueOpen, WorkLink("u", WorkLinkKind.ISSUE, WorkLinkProvider.GITHUB, "a/b#2").glyph)
        assertEquals(WorkLinkProvider.JIRA, workLinkProvider("jira"))
        assertEquals(WorkLinkProvider.GITHUB, workLinkProvider(null))
    }

    /** Every brand / agent mark is one colour, so `Icon` tints it with the content colour (no Slack four-colour, no Claude orange). */
    @Test
    fun brandAndAgentMarksAreMonochrome() {
        val marks = Brand.entries.map { it.icon } + AgentBrand.entries.filter { it != AgentBrand.OpenClaw }.map { it.icon }
        marks.forEach { icon ->
            val fills = (icon.root.toList()).filterIsInstance<VectorPath>().map { it.fill }
            assert(fills.isNotEmpty()) { icon.name }
            fills.forEach { assertEquals(icon.name, SolidColor(Color.Black), it) }
        }
    }

    private fun VectorGroup.toList(): List<Any> = (0 until size).flatMap { i ->
        when (val n = get(i)) {
            is VectorGroup -> n.toList()
            else -> listOf(n)
        }
    }
}
