package dev.optio.feature.glance.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.optio.feature.glance.GlanceRuntime
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * FCM entry point. The API sends data-only messages (`docs/android-push.md`), so this runs in the
 * background too and the app renders every notification itself. Runs only in builds with
 * `google-services.json`.
 */
class OptioMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val runtime = GlanceRuntime.get(this)
        // Called on a background thread; a high-priority message gets ~20 s to finish.
        runBlocking { withTimeoutOrNull(BUDGET) { runtime.push.handle(message.data) } }
    }

    /** A new registration token (Messaging 25.1+). */
    override fun onRegistered(token: String) {
        GlanceRuntime.get(this).registrar.onNewToken(token)
    }

    /** A new registration token (before Messaging 25.1). */
    @Deprecated("Firebase Messaging 25.1 calls onRegistered instead")
    override fun onNewToken(token: String) {
        GlanceRuntime.get(this).registrar.onNewToken(token)
    }

    private companion object {
        val BUDGET = 15.seconds
    }
}
