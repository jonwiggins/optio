package dev.optio.feature.local.automations

import dev.optio.core.model.LocalAgentKind
import dev.optio.core.model.LocalAgentSessionMode
import dev.optio.core.model.LocalBlueprintSpawnMode
import dev.optio.core.testing.Samples
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/** [AutomationForm]: iOS `BlueprintFormSheet`'s `canSave` / `save()` rules, with the web's explicit nulls on edit. */
class AutomationFormTest {
    private val valid =
        AutomationForm(
            name = "  Fix flaky tests ",
            location = AutomationForm.Location.DIR,
            dir = "/Users/dev/acme/web ",
            commandTemplate = "Find the flakiest test and fix it.\n",
        )

    @Test
    fun saveNeedsANameATemplateAndAPlace() {
        assertTrue(valid.canSave)
        assertNull(valid.problem)
        assertFalse(valid.copy(name = " ").canSave)
        assertEquals("Give it a name.", valid.copy(name = "").problem)
        assertFalse(valid.copy(commandTemplate = "  ").canSave)
        assertEquals("Write the command it runs.", valid.copy(commandTemplate = "", agent = null).problem)
        assertFalse(valid.copy(dir = "").canSave)
        assertFalse(valid.copy(location = AutomationForm.Location.REPO).canSave, "a repo URL is required in that mode")
        assertTrue(valid.copy(location = AutomationForm.Location.REPO, repoUrl = "https://github.com/acme/web").canSave)
        assertTrue(valid.copy(location = AutomationForm.Location.EVENT, dir = "").canSave, "the event's repo needs nothing more")
    }

    @Test
    fun creatingSendsOnlyWhatIsSet() {
        val json = valid.body(editing = false).toJson().toString()
        assertEquals(
            """{"name":"Fix flaky tests","dir":"/Users/dev/acme/web","commandTemplate":"Find the flakiest test and fix it.","agent":"claude-code","spawnMode":"hold","sessionMode":"interactive"}""",
            json,
        )
    }

    @Test
    fun editingSendsExplicitNullsForWhatWasCleared() {
        val shell = valid.copy(agent = null, location = AutomationForm.Location.EVENT, hostId = "", description = "")
        val json = shell.body(editing = true).toJson().toString()
        assertEquals(
            """{"name":"Fix flaky tests","description":null,"hostId":null,"dir":null,"repoUrl":null,"commandTemplate":"Find the flakiest test and fix it.","agent":null,"spawnMode":"hold"}""",
            json,
        )
        val repo = valid.copy(location = AutomationForm.Location.REPO, repoUrl = "https://github.com/acme/web", hostId = "h1", description = "Nightly")
        assertEquals(
            """{"name":"Fix flaky tests","description":"Nightly","hostId":"h1","dir":null,"repoUrl":"https://github.com/acme/web","commandTemplate":"Find the flakiest test and fix it.","agent":"claude-code","spawnMode":"hold","sessionMode":"interactive"}""",
            repo.body(editing = true).toJson().toString(),
        )
    }

    @Test
    fun anExistingAutomationRoundTrips() {
        val bp = Samples.localBlueprint()
        val form = AutomationForm.from(bp)
        assertEquals("Fix flaky tests", form.name)
        assertEquals(AutomationForm.Location.DIR, form.location)
        assertEquals("/Users/dev/acme/web", form.dir)
        assertEquals(LocalAgentKind.CLAUDE_CODE, form.agent)
        assertEquals(LocalAgentSessionMode.HEADLESS, form.sessionMode)
        assertEquals(LocalBlueprintSpawnMode.AUTO, form.spawnMode)

        val byRepo = AutomationForm.from(bp.copy(dir = null, repoUrl = "https://github.com/acme/web"))
        assertEquals(AutomationForm.Location.REPO, byRepo.location)
        val byEvent = AutomationForm.from(bp.copy(dir = null, repoUrl = null, agent = null))
        assertEquals(AutomationForm.Location.EVENT, byEvent.location)
        assertNull(byEvent.agent)
        assertEquals("claude {{prompt}}", AutomationForm.placeholder(byEvent.agent))
    }
}
