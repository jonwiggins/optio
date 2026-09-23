package dev.optio.feature.glance

import android.app.Activity
import android.app.Application
import android.os.Bundle
import dev.optio.core.glance.PushStatus
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Whether the app is on screen, and which activity is resumed (for the notification permission
 * prompt, which needs an activity). Registered once by [OptioGlance.install]. Also re-reads the
 * notification permission on every resume (the permission dialog's result is not delivered here).
 */
object AppForeground : Application.ActivityLifecycleCallbacks {
    private val started = AtomicInteger(0)
    private val _inForeground = MutableStateFlow(false)

    @Volatile
    private var resumed: WeakReference<Activity>? = null

    /** True while any activity of the app is started. */
    val inForeground: StateFlow<Boolean> = _inForeground.asStateFlow()

    val isForeground: Boolean
        get() = _inForeground.value

    /** The resumed activity, if any. */
    val resumedActivity: Activity?
        get() = resumed?.get()

    /** Debug launch extra that keeps the permission prompt away (scripted screenshots). */
    @Volatile
    var suppressPermissionPrompt: Boolean = false
        private set

    fun install(application: Application) {
        application.registerActivityLifecycleCallbacks(this)
    }

    override fun onActivityCreated(
        activity: Activity,
        savedInstanceState: Bundle?,
    ) {
        if (BuildConfig.DEBUG && activity.intent?.getStringExtra(NO_PUSH_PROMPT_EXTRA) != null) suppressPermissionPrompt = true
    }

    override fun onActivityStarted(activity: Activity) {
        if (started.incrementAndGet() == 1) _inForeground.value = true
    }

    override fun onActivityResumed(activity: Activity) {
        resumed = WeakReference(activity)
        PushStatus.get(activity).refreshPermission(activity.applicationContext)
    }

    override fun onActivityPaused(activity: Activity) {
        if (resumed?.get() === activity) resumed = null
    }

    override fun onActivityStopped(activity: Activity) {
        if (started.decrementAndGet() <= 0) {
            started.set(0)
            _inForeground.value = false
        }
    }

    override fun onActivitySaveInstanceState(
        activity: Activity,
        outState: Bundle,
    ) = Unit

    override fun onActivityDestroyed(activity: Activity) = Unit

    /** Tests: pretend the app is (or is not) on screen. */
    internal fun setForegroundForTest(foreground: Boolean) {
        _inForeground.value = foreground
    }

    /** iOS `SIMCTL_CHILD_OPTIO_DEV_NO_PUSH_PROMPT`: `--es OPTIO_DEV_NO_PUSH_PROMPT 1`. */
    const val NO_PUSH_PROMPT_EXTRA = "OPTIO_DEV_NO_PUSH_PROMPT"
}
