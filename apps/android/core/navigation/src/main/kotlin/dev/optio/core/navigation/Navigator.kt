package dev.optio.core.navigation

import androidx.navigation3.runtime.NavKey

/**
 * How feature code moves around the app. Read it with `LocalNavigator.current`.
 *
 * Features never depend on each other: to open another feature's screen, push that feature's
 * route key (all keys live in `dev.optio.core.navigation.routes`).
 */
interface Navigator {
    /** Pushes [route] onto the current tab's back stack. */
    fun push(route: NavKey)

    /** Pops the current tab's back stack; does nothing at the hub root. */
    fun pop()

    /**
     * Switches to the tab that owns [section], pops it to its hub and selects [section] there.
     * [view] preselects a Work view when [section] is [Section.WORK].
     */
    fun open(section: Section, view: WorkView? = null)

    /** Opens an http(s) URL outside the app (Custom Tabs in the app). */
    fun openExternal(url: String)

    companion object {
        /** Ignores every call. The default for previews and screenshot tests. */
        val None: Navigator = object : Navigator {
            override fun push(route: NavKey) = Unit

            override fun pop() = Unit

            override fun open(section: Section, view: WorkView?) = Unit

            override fun openExternal(url: String) = Unit
        }
    }
}

/** The app's [Navigator]: every call goes through [router]; [onOpenExternal] launches URLs. */
class RouterNavigator(
    private val router: AppRouter,
    private val onOpenExternal: (url: String) -> Unit,
) : Navigator {
    override fun push(route: NavKey) = router.push(route)

    override fun pop() {
        router.pop()
    }

    override fun open(section: Section, view: WorkView?) = router.open(section, view)

    override fun openExternal(url: String) = onOpenExternal(url)
}
