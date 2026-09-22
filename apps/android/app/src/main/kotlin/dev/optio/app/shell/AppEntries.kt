package dev.optio.app.shell

import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import dev.optio.core.navigation.routes.HubRoute
import dev.optio.core.ui.PlaceholderScreen
import dev.optio.feature.agents.agentsEntries
import dev.optio.feature.auth.authEntries
import dev.optio.feature.glance.glanceEntries
import dev.optio.feature.insights.insightsEntries
import dev.optio.feature.library.libraryEntries
import dev.optio.feature.local.localEntries
import dev.optio.feature.more.moreEntries
import dev.optio.feature.overview.overviewEntries
import dev.optio.feature.reviews.reviewsEntries
import dev.optio.feature.sessions.sessionsEntries
import dev.optio.feature.tasks.tasksEntries
import dev.optio.feature.work.workEntries
import dev.optio.feature.workform.workFormEntries

/**
 * Every route the app can show: the hub roots plus each feature module's `<module>Entries()`.
 * A key nobody registered renders a placeholder instead of crashing.
 */
internal fun appEntryProvider(): (NavKey) -> NavEntry<NavKey> =
    entryProvider(
        fallback = { key -> NavEntry(key) { PlaceholderScreen(title = "Unknown route", detail = key.toString()) } },
    ) {
        entry<HubRoute> { key -> HubScreen(key.tab) }
        authEntries()
        overviewEntries()
        workEntries()
        workFormEntries()
        tasksEntries()
        reviewsEntries()
        insightsEntries()
        localEntries()
        agentsEntries()
        sessionsEntries()
        libraryEntries()
        moreEntries()
        glanceEntries()
    }
