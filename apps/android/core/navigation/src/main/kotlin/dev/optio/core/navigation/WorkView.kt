package dev.optio.core.navigation

/** Saved filters over the Work feed (iOS `WorkView`); [raw] is the deep-link / wire name. */
enum class WorkView(val raw: String, val label: String) {
    ACTIVE("active", "Active"),
    RECURRING("recurring", "Recurring"),
    AGENTS("agents", "Agents"),
    HISTORY("history", "History"),
    ALL("all", "All"),
    ;

    companion object {
        /** `optio://section/work?view=<raw>` → the view, or null for an unknown name. */
        fun fromRaw(raw: String?): WorkView? = entries.firstOrNull { it.raw == raw }
    }
}
