package dev.optio.feature.local.automations

import dev.optio.core.model.LocalAgentKind
import dev.optio.core.model.LocalBlueprintSpawnMode
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/** [AutomationForm]: iOS `BlueprintFormSheet`'s `canSave` / `save()` rules. */
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
        val json = valid.body().toJson().toString()
        assertEquals(
            """{"name":"Fix flaky tests","dir":"/Users/dev/acme/web","commandTemplate":"Find the flakiest test and fix it.","agent":"claude-code","spawnMode":"hold","sessionMode":"interactive"}""",
            json,
        )
    }

    @Test
    fun aShellCommandFromTheEventsRepoSendsNoPlaceOrSessionMode() {
        val shell = valid.copy(agent = null, location = AutomationForm.Location.EVENT, spawnMode = LocalBlueprintSpawnMode.AUTO)
        assertEquals(
            """{"name":"Fix flaky tests","commandTemplate":"Find the flakiest test and fix it.","spawnMode":"auto"}""",
            shell.body().toJson().toString(),
        )
        assertEquals("claude {{prompt}}", AutomationForm.placeholder(shell.agent))
        assertEquals("Investigate {{ticketTitle}}", AutomationForm.placeholder(LocalAgentKind.CLAUDE_CODE))
    }
}
