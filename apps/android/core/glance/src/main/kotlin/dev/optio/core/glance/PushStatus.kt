package dev.optio.core.glance

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.annotation.ChecksSdkIntAtLeast
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import dev.optio.core.model.PushDevice
import dev.optio.core.model.PushPlatform
import java.time.Instant
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Notification permission and push delivery on this device, for the settings screens (the
 * notification-devices screen, the Watch settings) — the Android counterpart of iOS
 * `PushRegistrar`'s observable state.
 *
 * `:feature:glance` owns the machinery (the FCM client, registration with every paired server,
 * the background check, "Keep watching") and writes here; screens read [state] and may call
 * [refreshPermission] (e.g. on resume, after the permission dialog) and [syncNow] ("Retry
 * registration").
 *
 * ```
 * val push = remember { PushStatus.get(context) }
 * val state by push.state.collectAsStateWithLifecycle()
 * Text(state.permission.label)
 * state.server(activeServerId)?.let { Text(it.label(state)) }
 * ```
 */
class PushStatus internal constructor(
    private val appContext: Context?,
) {
    private val _state = MutableStateFlow(PushState())

    /** The current state; see [PushState]. */
    val state: StateFlow<PushState> = _state.asStateFlow()

    /** Set by `:feature:glance`: re-registers this device with every paired server. */
    @Volatile
    var syncHandler: (suspend () -> Unit)? = null

    /** Applies [transform] to the state (`:feature:glance` reports registration, FCM and polls here). */
    fun update(transform: (PushState) -> PushState) {
        _state.update(transform)
    }

    /**
     * Re-reads the notification permission (call on resume and after the permission dialog: the
     * dialog's result is not delivered to the screens that read this).
     */
    fun refreshPermission(context: Context? = appContext) {
        val ctx = context ?: return
        val permission = NotificationPermission.state(ctx, prompted = prompted(ctx))
        _state.update { it.copy(permission = permission) }
    }

    /** Records that the system prompt was shown (so a later "not granted" reads as denied). */
    fun markPrompted(context: Context? = appContext) {
        val ctx = context ?: return
        prefs(ctx).edit { putBoolean(PROMPTED_ONCE, true) }
        refreshPermission(ctx)
    }

    /** Whether the system prompt was shown before. */
    fun prompted(context: Context? = appContext): Boolean = context?.let { prefs(it).getBoolean(PROMPTED_ONCE, false) } ?: false

    /** Registers this device with every paired server now ("Retry registration"); no-op without FCM. */
    suspend fun syncNow() {
        syncHandler?.invoke()
    }

    /**
     * Whether [serverId] pushes its own alerts to this device (registered, and the server has FCM
     * credentials). Remembered across processes, so a background check in a fresh process does
     * not alert about what the server already pushed.
     */
    fun isPushCovered(serverId: String): Boolean =
        state.value.server(serverId)?.receivesPush ?: (appContext?.let { serverId in covered(it) } ?: false)

    /** Records whether [serverId] pushes to this device (see [isPushCovered]). */
    fun setPushCovered(
        serverId: String,
        covered: Boolean,
    ) {
        val ctx = appContext ?: return
        val now = covered(ctx)
        val next = if (covered) now + serverId else now - serverId
        if (next != now) prefs(ctx).edit { putStringSet(PUSH_COVERED, next) }
    }

    private fun covered(context: Context): Set<String> = prefs(context).getStringSet(PUSH_COVERED, null).orEmpty()

    companion object {
        private const val PROMPTED_ONCE = "optio.push.promptedOnce"
        private const val PUSH_COVERED = "optio.push.coveredServers"

        @Volatile
        private var shared: PushStatus? = null

        /** The process's instance; the permission is read on first use. */
        fun get(context: Context): PushStatus =
            shared ?: synchronized(this) {
                shared ?: PushStatus(context.applicationContext).also {
                    shared = it
                    it.refreshPermission(context.applicationContext)
                }
            }

        /** A detached instance: tests and previews (nothing reads the system). */
        fun detached(initial: PushState = PushState()): PushStatus = PushStatus(null).also { s -> s.update { initial } }

        private fun prefs(context: Context) = context.applicationContext.getSharedPreferences("optio_push", Context.MODE_PRIVATE)
    }
}

/** A snapshot of notification permission and push delivery ([PushStatus.state]). */
data class PushState(
    /** Whether notifications can be shown at all. */
    val permission: NotificationPermissionState = NotificationPermissionState.NOT_DETERMINED,
    /** Firebase Cloud Messaging in this build. */
    val fcm: FcmAvailability = FcmAvailability.Unknown,
    /** This device's FCM registration token, when Firebase issued one. */
    val token: String? = null,
    /** This device's registration with each paired server, by `ServerProfile.id`. */
    val servers: Map<String, ServerPushState> = emptyMap(),
    /** "Keep watching in the background" is switched on. */
    val keepWatching: Boolean = false,
    /** The keep-watching service is running right now. */
    val keepWatchingActive: Boolean = false,
    /** The last on-device background check (WorkManager), and its error if it failed. */
    val lastPollAt: Instant? = null,
    val lastPollError: String? = null,
) {
    /** The token as the server lists it (`abcdef…wxyz`), or null. */
    val maskedToken: String?
        get() = token?.let(::maskToken)

    /** This device's state on [serverId]. */
    fun server(serverId: String?): ServerPushState? = serverId?.let(servers::get)

    /** True when [device] (a row of `GET /api/notifications/devices`) is this phone. */
    fun isThisDevice(device: PushDevice): Boolean {
        val masked = maskedToken ?: return false
        if (device.platform != PushPlatform.ANDROID) return false
        val registered = servers.values.mapNotNull { it.deviceId }
        return device.id in registered || device.token == masked
    }

    companion object {
        /** The server's mask: first 6 and last 4 characters (`…` for short tokens). */
        fun maskToken(token: String): String = if (token.length <= 12) "…" else "${token.take(6)}…${token.takeLast(4)}"
    }
}

/** Whether notifications can be shown. */
enum class NotificationPermissionState(
    val label: String,
) {
    /** Allowed (and not switched off for the app). */
    GRANTED("Notifications allowed"),

    /** Refused, or switched off in system settings. */
    DENIED("Notifications off"),

    /** Android 13+: the system prompt was never shown. */
    NOT_DETERMINED("Not asked yet"),
}

/** Firebase Cloud Messaging in this build. */
sealed interface FcmAvailability {
    /** Not checked yet. */
    data object Unknown : FcmAvailability

    /** Built without `google-services.json`: server push is off, the on-device baseline works. */
    data object NotConfigured : FcmAvailability

    /** Configured, but Firebase could not issue a token (no Google Play services, offline, …). */
    data class Unavailable(
        val reason: String,
    ) : FcmAvailability

    /** Firebase issued a token. */
    data object Available : FcmAvailability
}

/** This device's registration with one paired server. */
data class ServerPushState(
    val serverId: String,
    val registration: PushRegistration = PushRegistration.IDLE,
    /** `push.fcm` from `GET /api/notifications/devices`: the server holds FCM credentials. Null = unknown. */
    val serverCanPush: Boolean? = null,
    /** The device row id the server returned (delete by id; tokens are masked in the list). */
    val deviceId: String? = null,
    /** Why the last registration failed. */
    val error: String? = null,
    val updatedAt: Instant? = null,
) {
    /** The server will push to this device: registered, and it has FCM credentials. */
    val receivesPush: Boolean
        get() = registration == PushRegistration.REGISTERED && serverCanPush == true

    /** iOS `registrationLabel`. */
    fun label(push: PushState): String =
        when (registration) {
            PushRegistration.IDLE ->
                when {
                    push.fcm == FcmAvailability.NotConfigured -> "Push needs a Firebase build"
                    push.permission != NotificationPermissionState.GRANTED -> "Waiting for permission"
                    else -> "Not registered yet"
                }
            PushRegistration.REGISTERING -> "Registering this device…"
            PushRegistration.REGISTERED -> if (serverCanPush == false) "Registered; the server can't push yet" else "Registered with your Optio server"
            PushRegistration.UNSUPPORTED, PushRegistration.FAILED -> "Token issued, not on the server"
        }

    /** iOS `registrationDetail`. */
    fun detail(push: PushState): String? =
        when {
            registration == PushRegistration.UNSUPPORTED -> "The server doesn't have a device registry yet — update Optio."
            registration == PushRegistration.FAILED -> error ?: "Couldn't reach the server to register this device."
            registration == PushRegistration.REGISTERED && serverCanPush == false ->
                "The server has no Firebase credentials (notifications.fcm), so the phone checks on its own."
            push.fcm == FcmAvailability.NotConfigured -> "No google-services.json in this build."
            else -> error
        }
}

/** Where registration with one server stands (iOS `PushRegistrar.Registration`). */
enum class PushRegistration {
    /** Nothing attempted yet (no token, no permission, or just launched). */
    IDLE,

    /** Sending the token to the server. */
    REGISTERING,

    /** The server accepted the token. */
    REGISTERED,

    /** The server predates device registration (404). */
    UNSUPPORTED,

    /** The server could not be reached or refused (see [ServerPushState.error]). */
    FAILED,
}

/** The notification permission: `POST_NOTIFICATIONS` on Android 13+, the app switch everywhere. */
object NotificationPermission {
    /** `android.permission.POST_NOTIFICATIONS` (runtime on Android 13+). */
    const val PERMISSION: String = "android.permission.POST_NOTIFICATIONS"

    /** Android 13+ asks at runtime. */
    @get:ChecksSdkIntAtLeast(api = 33)
    val isRuntime: Boolean
        get() = Build.VERSION.SDK_INT >= 33

    /** Notifications can be posted: the permission is granted (or not needed) and the app switch is on. */
    fun isGranted(context: Context): Boolean {
        val permitted = !isRuntime || ContextCompat.checkSelfPermission(context, PERMISSION) == PackageManager.PERMISSION_GRANTED
        return permitted && NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /** The state, given whether the prompt was ever shown. */
    fun state(
        context: Context,
        prompted: Boolean,
    ): NotificationPermissionState =
        when {
            isGranted(context) -> NotificationPermissionState.GRANTED
            isRuntime && !prompted && ContextCompat.checkSelfPermission(context, PERMISSION) != PackageManager.PERMISSION_GRANTED ->
                NotificationPermissionState.NOT_DETERMINED
            else -> NotificationPermissionState.DENIED
        }

    /** The system screen for this app's notifications (where a denied permission is turned back on). */
    fun settingsIntent(context: Context): Intent =
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}
