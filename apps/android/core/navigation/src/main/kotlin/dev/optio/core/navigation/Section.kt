package dev.optio.core.navigation

/**
 * A hub section: one segment of a tab's switcher (iOS `AppRouter.Section`). Each section's content
 * is a composable exported by the owning feature module (see the README's section table).
 */
enum class Section(val tab: Tab, val label: String) {
    WORK(Tab.WORK, "All"),
    REVIEWS(Tab.WORK, "Reviews"),
    INBOX(Tab.WORK, "Inbox"),
    PROMPTS(Tab.LIBRARY, "Prompts"),
    REPOS(Tab.LIBRARY, "Repos"),
    MACHINES(Tab.LIBRARY, "Machines"),
    CONNECTIONS(Tab.LIBRARY, "Connections"),
    ANALYTICS(Tab.INSIGHTS, "Analytics"),
    COSTS(Tab.INSIGHTS, "Costs"),
    ACTIVITY(Tab.INSIGHTS, "Activity"),
    CLUSTER(Tab.INSIGHTS, "Cluster"),
}
