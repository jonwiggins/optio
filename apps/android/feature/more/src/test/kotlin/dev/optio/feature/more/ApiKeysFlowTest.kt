package dev.optio.feature.more

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.Fixtures
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.feature.more.api.CreatedApiKey
import dev.optio.feature.more.settings.ApiKeysScreen
import kotlin.test.assertEquals
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * The access-token screen end to end over the fake API: New → name → Create shows the whole
 * token once in a sheet that only Done closes; Done forgets it and reloads the list.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class ApiKeysFlowTest {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val fake = FakeOptioServerRule()

    @Test
    fun theNewTokenIsShownOnceThenGone() {
        val server = fake.server
        server.fixture("/api/auth/api-keys", "api-keys.json")
        server.post("/api/auth/api-keys") { FakeResponse.fixture("api-key-created.json", 201) }
        val token = Fixtures.decode<CreatedApiKey>("api-key-created.json").token
        compose.setContent {
            OptioTheme(darkTheme = false) {
                CompositionLocalProvider(LocalApiClient provides server.client(), LocalCurrentUser provides MoreSamples.user("admin")) {
                    ApiKeysScreen()
                }
            }
        }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("api-keys").fetchSemanticsNodes().isNotEmpty() }

        compose.onNodeWithTag("new-token").performClick()
        compose.onNodeWithTag("token-name").performTextInput("Pixel 10")
        compose.onNodeWithTag("sheet-confirm").performClick() // Create
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("created-token").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(token).assertIsDisplayed()
        compose.onAllNodesWithTag("sheet-dismiss").assertCountEquals(0) // no Cancel once the token exists
        assertEquals("Pixel 10", server.lastRequest("POST", "/api/auth/api-keys")!!.json.jsonObject["name"]!!.jsonPrimitive.content)

        val listsBefore = server.count("GET", "/api/auth/api-keys")
        compose.onNodeWithTag("sheet-confirm").performClick() // Done
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("created-token").fetchSemanticsNodes().isEmpty() }
        compose.onAllNodesWithText(token).assertCountEquals(0)
        compose.waitUntil(5_000) { server.count("GET", "/api/auth/api-keys") > listsBefore }
    }
}
