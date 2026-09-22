package dev.optio.core.navigation

/** The five top-level tabs (iOS `AppRouter.Tab`), in bottom-bar order. */
enum class Tab(val label: String) {
    OVERVIEW("Overview"),
    WORK("Work"),
    LIBRARY("Library"),
    INSIGHTS("Insights"),
    MORE("More"),
    ;

    /** The hub sections in this tab's segmented switcher, in order; empty for single-screen hubs. */
    val sections: List<Section>
        get() = Section.entries.filter { it.tab == this }
}
