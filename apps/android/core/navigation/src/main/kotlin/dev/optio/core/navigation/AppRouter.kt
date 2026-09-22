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
import dev.optio.core.navigation.routes.HubRoute
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * Cross-tab navigation state (port of iOS `App/AppRouter.swift`): the selected tab, one back stack
 * per tab (iOS has a NavigationStack per tab), and the section selected in each hub.
 *
 * Every back stack starts with (and never pops past) its [HubRoute]. Details push on top.
 * Agent C extends this with the pending deep-link state (pendingDetail, pendingNewWork,
 * createdWork, createdToast, `handle(DeepLink)`, `showCreatedWork`).
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

    companion object {
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
