package dev.optio.core.navigation

import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.AddServerRoute
import dev.optio.core.navigation.routes.AgentDetailRoute
import dev.optio.core.navigation.routes.AgentFormRoute
import dev.optio.core.navigation.routes.ApiKeysRoute
import dev.optio.core.navigation.routes.AppIconRoute
import dev.optio.core.navigation.routes.ConnectionDetailRoute
import dev.optio.core.navigation.routes.EditWorkRoute
import dev.optio.core.navigation.routes.HubRoute
import dev.optio.core.navigation.routes.JobDetailRoute
import dev.optio.core.navigation.routes.JobFormRoute
import dev.optio.core.navigation.routes.JobRunRoute
import dev.optio.core.navigation.routes.LocalAutomationRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.navigation.routes.NewConnectionRoute
import dev.optio.core.navigation.routes.NewRepoRoute
import dev.optio.core.navigation.routes.NewWorkRoute
import dev.optio.core.navigation.routes.NotificationDevicesRoute
import dev.optio.core.navigation.routes.NotificationPrefsRoute
import dev.optio.core.navigation.routes.OptioAgentSettingsRoute
import dev.optio.core.navigation.routes.PodDetailRoute
import dev.optio.core.navigation.routes.PromptDetailRoute
import dev.optio.core.navigation.routes.RepoDetailRoute
import dev.optio.core.navigation.routes.RepoSettingsRoute
import dev.optio.core.navigation.routes.ReviewDetailRoute
import dev.optio.core.navigation.routes.ScheduledDetailRoute
import dev.optio.core.navigation.routes.SecretsRoute
import dev.optio.core.navigation.routes.ServersRoute
import dev.optio.core.navigation.routes.SessionDetailRoute
import dev.optio.core.navigation.routes.SettingsRoute
import dev.optio.core.navigation.routes.SharedDirectoriesRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.navigation.routes.WebhookDetailRoute
import dev.optio.core.navigation.routes.WebhooksRoute
import dev.optio.core.navigation.routes.WorkspaceSettingsRoute
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame

class RoutesSerializationTest {
    /** One instance of every route in PLAN §5 (plus the hub roots), defaults and non-defaults. */
    private val everyRoute: List<NavKey> =
        Tab.entries.map(::HubRoute) +
            listOf(
                AddServerRoute,
                NewWorkRoute(),
                NewWorkRoute(preset = "pr-review"),
                EditWorkRoute("w1"),
                TaskDetailRoute("t1"),
                JobDetailRoute("j1"),
                JobRunRoute(jobId = "j1", runId = "r1"),
                JobFormRoute(),
                JobFormRoute("j1"),
                ScheduledDetailRoute("s1"),
                ReviewDetailRoute("rv1"),
                PodDetailRoute("p1"),
                LocalTerminalRoute("lt1"),
                LocalTerminalRoute("lt1", compose = true),
                LocalAutomationRoute("la1"),
                AgentDetailRoute("a1", compose = true),
                AgentFormRoute(),
                SessionDetailRoute("se1"),
                PromptDetailRoute(),
                PromptDetailRoute("pr1"),
                RepoDetailRoute("r1"),
                RepoSettingsRoute("r1"),
                SharedDirectoriesRoute("r1"),
                NewRepoRoute,
                ConnectionDetailRoute("c1"),
                NewConnectionRoute("notion"),
                SettingsRoute,
                ApiKeysRoute,
                NotificationPrefsRoute,
                NotificationDevicesRoute,
                OptioAgentSettingsRoute,
                AppIconRoute,
                SecretsRoute,
                WebhooksRoute,
                WebhookDetailRoute("wh1"),
                WorkspaceSettingsRoute,
                ServersRoute,
            )

    @Test
    fun everyRouteRoundTripsThroughTheBackStackCodec() {
        val decoded = AppRouter.decodeBackStack(AppRouter.encodeBackStack(everyRoute))
        assertEquals(everyRoute, decoded)
    }

    @Test
    fun objectRoutesDecodeToTheirSingleton() {
        val decoded = AppRouter.decodeBackStack(AppRouter.encodeBackStack(listOf(SettingsRoute, NewRepoRoute)))
        assertSame(SettingsRoute, decoded[0])
        assertSame(NewRepoRoute, decoded[1])
    }

    @Test
    fun defaultArgumentsAreOmittedFromTheEncoding() {
        val encoded = AppRouter.encodeBackStack(listOf(LocalTerminalRoute("lt1")))
        assertEquals(false, encoded.contains("compose"), encoded)
    }
}
