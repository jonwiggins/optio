package dev.optio.core.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.serialization.NavKeySerializer
import dev.optio.core.data.DeepLink
import dev.optio.core.navigation.routes.AgentDetailRoute
import dev.optio.core.navigation.routes.EditWorkRoute
import dev.optio.core.navigation.routes.HubRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.navigation.routes.NewWorkRoute
import dev.optio.core.navigation.routes.SessionDetailRoute
import dev.optio.core.navigation.routes.SettingsRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * Cross-tab navigation state (port of iOS `App/AppRouter.swift`): the selected tab, one back stack
 * per tab (iOS has a NavigationStack per tab), and the section selected in each hub.
 *
 * Every back stack starts with (and never pops past) its [HubRoute]. Details push on top.
 *
 * Deep links ([handle]) and "show what the form just created" ([showCreatedWork]) act on the back
 * stacks directly, since this router owns them: where iOS parks `pendingDetail` /
 * `pendingNewWork` / `createdWork` for the Work hub to consume, a detail (`LocalTerminalRoute`,
 * `NewWorkRoute`, …) is pushed onto the owning tab at once. [pendingWorkView] stays pending (the
 * Work list consumes it) and [createdToast] waits for the shell's snackbar.
 */
@Stable
class AppRouter(
    selectedTab: Tab = Tab.OVERVIEW,
    backStacks: Map<Tab, List<NavKey>> = emptyMap(),
    sections: Map<Tab, Section> = emptyMap(),
) {
    /** The tab on screen. Change it with [select] (bottom bar) or [open] (cross-tab). */
    var selectedTab: Tab by mutableStateOf(selectedTab)
        private set

    private val stacks: Map<Tab, SnapshotStateList<NavKey>> =
        Tab.entries.associateWith { tab ->
            val initial = backStacks[tab].orEmpty().ifEmpty { listOf(HubRoute(tab)) }
            mutableStateListOf<NavKey>().apply { addAll(initial) }
        }

    private val selectedSections = mutableStateMapOf<Tab, Section>().apply { putAll(sections) }

    /**
     * The Work view the Work list should select next (Overview tiles, `optio://section/work?view=`).
     * The Work list consumes it: reads it, then sets it back to null.
     */
    var pendingWorkView: WorkView? by mutableStateOf(null)

    /** The route [showCreatedWork] last pushed (iOS `createdWork`); null until then. */
    var createdWork: NavKey? by mutableStateOf(null)
        private set

    /**
     * The confirmation [showCreatedWork] wants shown (iOS `createdToast`). The shell shows it as a
     * snackbar and calls [consumeCreatedToast].
     */
    var createdToast: String? by mutableStateOf(null)
        private set

    /** [tab]'s back stack; the root entry is always `HubRoute(tab)`. */
    fun backStack(tab: Tab): SnapshotStateList<NavKey> = stacks.getValue(tab)

    val currentBackStack: SnapshotStateList<NavKey>
        get() = backStack(selectedTab)

    /** The section [tab]'s hub shows (its first section until one is selected); null if it has none. */
    fun section(tab: Tab): Section? = selectedSections[tab] ?: tab.sections.firstOrNull()

    /** Selects [section] in its hub without switching tabs (the hub's segmented switcher). */
    fun selectSection(section: Section) {
        selectedSections[section.tab] = section
    }

    /** Bottom-bar tap: switches to [tab]; re-selecting the tab on screen pops it to its hub. */
    fun select(tab: Tab) {
        if (tab == selectedTab) popToRoot(tab) else selectedTab = tab
    }

    /** Pushes [route] onto [tab]'s back stack (the current tab by default). */
    fun push(route: NavKey, tab: Tab = selectedTab) {
        backStack(tab).add(route)
    }

    /** Pops [tab]'s back stack. Returns false (and does nothing) at the hub root. */
    fun pop(tab: Tab = selectedTab): Boolean {
        val stack = backStack(tab)
        if (stack.size <= 1) return false
        stack.removeAt(stack.lastIndex)
        return true
    }

    /** Drops everything above [tab]'s hub. */
    fun popToRoot(tab: Tab = selectedTab) {
        val stack = backStack(tab)
        while (stack.size > 1) stack.removeAt(stack.lastIndex)
    }

    /**
     * Cross-tab jump (iOS `open(_:view:)`): selects [section] in its hub, pops that tab to the hub
     * so the section is visible, and switches to it. [view] preselects a Work view.
     */
    fun open(section: Section, view: WorkView? = null) {
        selectedSections[section.tab] = section
        if (section == Section.WORK && view != null) pendingWorkView = view
        popToRoot(section.tab)
        selectedTab = section.tab
    }

    /** Straight to the Work list in a given view (Overview tiles). */
    fun openWork(view: WorkView) = open(Section.WORK, view)

    /** The tab that owns [section] (iOS `tab(for:)`). */
    fun tab(section: Section): Tab = section.tab

    /** Switches to [tab] showing its hub (pops it to the root; no-op pop when already there). */
    fun openTab(tab: Tab) {
        popToRoot(tab)
        selectedTab = tab
    }

    /**
     * Handles an `optio://` URL from a widget, tile, notification, shortcut or another app (iOS
     * `handle(url:)`). The `?server=` hint is the caller's business (switch servers first); here
     * it is ignored. Returns false for a URL this app does not understand.
     */
    fun handle(url: String): Boolean {
        val link = DeepLink.parse(url) ?: return false
        return handle(link, explicitView = WorkView.fromRaw(DeepLink.queryValue(url, "view")))
    }

    /**
     * Routes [link]: details push onto the Work tab (replacing whatever was there, so a deep link
     * lands in one hop), `needs-you` / `section/…` open their hub, `work/new` pushes the New work
     * form, `settings` opens More › Settings. [explicitView] (`?view=` on a `section/<legacy name>`
     * URL) overrides the section's view.
     */
    fun handle(
        link: DeepLink,
        explicitView: WorkView? = null,
    ): Boolean {
        when (link) {
            is DeepLink.Task -> openDetail(TaskDetailRoute(link.id))
            is DeepLink.Local -> openDetail(LocalTerminalRoute(link.id, compose = link.compose))
            is DeepLink.Agent -> openDetail(AgentDetailRoute(link.id, compose = link.compose))
            is DeepLink.Session -> openDetail(SessionDetailRoute(link.id))
            DeepLink.NeedsYou -> open(Section.WORK, WorkView.ACTIVE)
            DeepLink.NewWork -> openDetail(NewWorkRoute())
            is DeepLink.Work -> open(Section.WORK, WorkView.fromRaw(link.view) ?: WorkView.ACTIVE)
            is DeepLink.Section -> {
                val target = section(named = link.name)
                when {
                    target != null -> open(target.first, explicitView ?: target.second)
                    link.name == "more" -> openTab(Tab.MORE)
                    else -> return false
                }
            }
            DeepLink.Settings -> {
                openTab(Tab.MORE)
                push(SettingsRoute, Tab.MORE)
            }
        }
        return true
    }

    /**
     * After the New / Edit work form submits (iOS `showCreatedWork`): closes the form (the topmost
     * `NewWorkRoute` / `EditWorkRoute` on the current tab), lands on Work › All with [route] pushed,
     * and queues [toast] for the shell's snackbar. Call it instead of popping the form yourself.
     */
    fun showCreatedWork(
        route: NavKey,
        toast: String,
    ) {
        val stack = currentBackStack
        val formIndex = stack.indexOfLast { it is NewWorkRoute || it is EditWorkRoute }
        if (formIndex > 0) stack.removeAt(formIndex)
        openDetail(route)
        createdWork = route
        createdToast = toast
    }

    /** The shell showed [createdToast]; clears it. */
    fun consumeCreatedToast() {
        createdToast = null
    }

    /** Work › All with [route] on top of the Work hub. */
    private fun openDetail(route: NavKey) {
        open(Section.WORK)
        push(route, Tab.WORK)
    }

    companion object {
        /**
         * `optio://section/<name>` names, legacy ones included (the pre-v0.6 nav), → where they live
         * now (iOS `section(named:)`). Every old per-kind list is a view of the one Work list.
         */
        fun section(named: String): Pair<Section, WorkView?>? =
            when (named) {
                "work", "sessions" -> Section.WORK to null
                "tasks" -> Section.WORK to WorkView.ALL
                "jobs", "scheduled" -> Section.WORK to WorkView.RECURRING
                "agents" -> Section.WORK to WorkView.AGENTS
                "local" -> Section.WORK to WorkView.ACTIVE
                "reviews" -> Section.REVIEWS to null
                "issues", "inbox" -> Section.INBOX to null
                "prompts", "templates" -> Section.PROMPTS to null
                "repos" -> Section.REPOS to null
                "machines", "hosts" -> Section.MACHINES to null
                "connections" -> Section.CONNECTIONS to null
                "analytics" -> Section.ANALYTICS to null
                "costs" -> Section.COSTS to null
                "activity" -> Section.ACTIVITY to null
                "cluster" -> Section.CLUSTER to null
                else -> null
            }

        private val json = Json { encodeDefaults = false }
        private val stackSerializer = ListSerializer(NavKeySerializer<NavKey>())

        /** Encodes a back stack as JSON (routes are `@Serializable` [NavKey]s). */
        fun encodeBackStack(stack: List<NavKey>): String = json.encodeToString(stackSerializer, stack)

        /** Decodes [encodeBackStack] output. Throws if a route class no longer exists. */
        fun decodeBackStack(encoded: String): List<NavKey> = json.decodeFromString(stackSerializer, encoded)

        /**
         * Saves the selected tab, hub sections and every back stack across configuration changes
         * and process death. A stack that no longer decodes (renamed route) restarts at its hub.
         */
        val Saver: Saver<AppRouter, Any> =
            listSaver(
                save = { router ->
                    buildList {
                        add(router.selectedTab.name)
                        add(Tab.entries.joinToString(",") { tab -> router.selectedSections[tab]?.name.orEmpty() })
                        Tab.entries.forEach { tab -> add(encodeBackStack(router.backStack(tab).toList())) }
                    }
                },
                restore = { saved ->
                    val sectionNames = saved[1].split(",")
                    AppRouter(
                        selectedTab = Tab.valueOf(saved[0]),
                        backStacks =
                            Tab.entries.withIndex().associate { (index, tab) ->
                                tab to runCatching { decodeBackStack(saved[2 + index]) }.getOrDefault(emptyList())
                            },
                        sections =
                            Tab.entries.withIndex().mapNotNull { (index, tab) ->
                                Section.entries.firstOrNull { it.name == sectionNames.getOrNull(index) }?.let { tab to it }
                            }.toMap(),
                    )
                },
            )
    }
}

/** The shell's [AppRouter], saved across configuration changes and process death. */
@Composable
fun rememberAppRouter(): AppRouter = rememberSaveable(saver = AppRouter.Saver) { AppRouter() }
