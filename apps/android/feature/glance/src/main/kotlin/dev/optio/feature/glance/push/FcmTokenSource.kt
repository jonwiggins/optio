package dev.optio.feature.glance.push

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import dev.optio.core.glance.FcmAvailability
import dev.optio.feature.glance.BuildConfig
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/** Where this device's FCM registration token comes from. */
interface FcmTokenSource {
    /** Whether FCM can work in this build at all (checked before [token]). */
    fun availability(): FcmAvailability

    /** The current token; throws when Firebase cannot issue one. */
    suspend fun token(): String
}

/**
 * The real token source. Firebase initialises itself only when the app was built with
 * `app/google-services.json` (the google-services plugin generates its options); without it
 * there is no default `FirebaseApp` and every FCM path stays off ([FcmAvailability.NotConfigured]).
 *
 * Debug builds accept a fake token (`adb shell am broadcast … DEBUG_FCM_TOKEN`, see
 * `DebugPushReceiver`) so registration can be exercised against a test API without Firebase.
 */
class FirebaseTokenSource(
    private val context: Context,
) : FcmTokenSource {
    override fun availability(): FcmAvailability {
        if (debugToken() != null) return FcmAvailability.Available
        return if (firebaseConfigured(context)) FcmAvailability.Available else FcmAvailability.NotConfigured
    }

    override suspend fun token(): String {
        debugToken()?.let { return it }
        if (!firebaseConfigured(context)) error("Firebase is not configured in this build")
        // Messaging 25.1 prefers register() + FirebaseMessagingService.onRegistered; getToken()
        // still issues (and caches) the same token and lets registration read it synchronously.
        @Suppress("DEPRECATION")
        return FirebaseMessaging.getInstance().token.await()
    }

    private fun debugToken(): String? =
        if (BuildConfig.DEBUG) context.getSharedPreferences(DEBUG_PREFS, Context.MODE_PRIVATE).getString(DEBUG_TOKEN, null) else null

    companion object {
        const val DEBUG_PREFS = "optio_debug_push"
        const val DEBUG_TOKEN = "fakeToken"

        /** A default FirebaseApp exists (the build had google-services.json). */
        fun firebaseConfigured(context: Context): Boolean = runCatching { FirebaseApp.getApps(context).isNotEmpty() }.getOrDefault(false)
    }
}

/** Awaits a Play-services [Task] without the coroutines-play-services artifact. */
suspend fun <T> Task<T>.await(): T =
    suspendCancellableCoroutine { cont ->
        addOnCompleteListener { task ->
            val error = task.exception
            when {
                error != null -> cont.resumeWithException(error)
                task.isCanceled -> cont.cancel()
                else -> cont.resume(task.result)
            }
        }
    }
